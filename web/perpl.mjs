// Read-only view of the real Mandate vault on Monad testnet that trades on
// Perpl's testnet exchange. It is not the demo's chain: a separate provider on
// the public testnet RPC, read-only calls, no key. Addresses come from
// contracts/deployments/perpl-10143.json; the result is cached so page loads
// do not hammer the public node.
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider } from "ethers";

export const PERPL_RPC = "https://testnet-rpc.monad.xyz";
export const PERPL_EXPLORER = "https://testnet.monadscan.com";
const CACHE_MS = 30_000;
const STATES = ["Active", "Frozen", "Closed"];

// Human-readable fragments, so the endpoint needs no compiled artifacts.
const ADAPTER_ABI = [
  "function positionState(address vault) view returns (uint256 positionNotional, uint256 totalNotional)",
  "function markEquity(address vault) view returns (uint256 equity, uint256 markedAt)",
  "function marketPrice(uint256 marketId) view returns (uint256 priceE18, uint256 markedAt)",
  "function venueLeverageHdths() view returns (uint256)",
  "function maxAdverseLimitBps() view returns (uint256)"
];
const VAULT_ABI = [
  "function state() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)"
];
const GUARD_ABI = [
  "function termsLocked(address vault) view returns (bool)",
  "function termsHash(address vault) view returns (bytes32)",
  "function limitsOf(address vault) view returns (tuple(uint16 maxLeverageX100, uint16 maxDrawdownBps, uint32 minBlocksBetweenTrades, uint32 maxMarkAgeSeconds, uint256 maxOrderNotional, uint256 maxPositionNotional, uint256 maxTotalNotional, uint256 maxBlockNotional, uint32 volWindowSeconds, uint32 stressHorizonSeconds, uint16 stressSigmasX10))"
];

// The agent script's own log (contracts/deployments/perpl-agent-10143.jsonl), one
// JSON line per tick. The page's totals and recent transactions come from it, so a
// new run shows up by committing its lines; nothing about the runs is typed here.
export const AGENT_LOG_URL = new URL("../contracts/deployments/perpl-agent-10143.jsonl", import.meta.url);
const RECENT = 8;

export function summarizeAgentLog(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn last line is skipped */ }
  }
  const runs = new Set();
  const txs = [];
  let ticks = 0;
  for (const e of events) {
    if (e.run !== undefined) runs.add(e.run);
    if (e.kind === "tick") ticks += 1;
    if (e.kind === "tick" && e.tx && e.status === 1) {
      txs.push({ time: e.time, kind: "fill", label: `${e.action} ${Math.abs(e.orderBtc)} BTC`, hash: e.tx });
    }
    if (e.kind === "exit" && e.tx && e.status === 1) {
      txs.push({ time: e.time, kind: "fill", label: "close the position", hash: e.tx });
    }
    if (e.breach?.tx) {
      txs.push({ time: e.time, kind: "refusal", label: `$${e.breach.notionalUsd} position, ${e.breach.error}`, hash: e.breach.tx });
    }
  }
  return {
    runs: runs.size,
    ticks,
    fills: txs.filter((t) => t.kind === "fill").length,
    refusals: txs.filter((t) => t.kind === "refusal").length,
    firstAt: events[0]?.time ?? null,
    lastAt: events.at(-1)?.time ?? null,
    recent: txs.slice(-RECENT).reverse()
  };
}

export function loadPerplDeployment() {
  return JSON.parse(readFileSync(new URL("../contracts/deployments/perpl-10143.json", import.meta.url), "utf8"));
}

// Everything is stringified here: bigints do not survive JSON, and the page
// formats them (equity and assets are 6-decimal aUSD, notionals and prices e18).
export async function readPerpl({
  deployment,
  provider,
  contract = (address, abi) => new Contract(address, abi, provider),
  agentLog = () => readFileSync(AGENT_LOG_URL, "utf8")
}) {
  const vaultAddress = deployment.vault;
  const adapter = contract(deployment.PerplAdapter, ADAPTER_ABI);
  const vault = contract(vaultAddress, VAULT_ABI);
  const guard = contract(deployment.MandateRiskGuard, GUARD_ABI);
  const [position, equity, mark, state, totalAssets, totalSupply, leverage, band, locked, limits] = await Promise.all([
    adapter.positionState(vaultAddress),
    adapter.markEquity(vaultAddress),
    adapter.marketPrice(0),
    vault.state(),
    vault.totalAssets(),
    vault.totalSupply(),
    adapter.venueLeverageHdths(),
    adapter.maxAdverseLimitBps(),
    guard.termsLocked(vaultAddress),
    guard.limitsOf(vaultAddress)
  ]);
  return {
    chainId: Number(deployment.chainId),
    explorer: PERPL_EXPLORER,
    addresses: {
      vault: vaultAddress,
      adapter: deployment.PerplAdapter,
      riskGuard: deployment.MandateRiskGuard,
      registry: deployment.MandateRegistry,
      factory: deployment.MandateFactory,
      exchange: deployment.perpl?.exchange
    },
    termsHash: deployment.termsHash,
    vault: {
      status: STATES[Number(state)] ?? `state ${state}`,
      totalAssets: totalAssets.toString(),
      totalSupply: totalSupply.toString()
    },
    position: { positionNotional: position[0].toString(), totalNotional: position[1].toString() },
    equity: { value: equity[0].toString(), markedAt: Number(equity[1]) },
    mark: { market: "BTC", priceE18: mark[0].toString(), markedAt: Number(mark[1]) },
    terms: {
      locked,
      maxPositionNotional: limits.maxPositionNotional.toString(),
      maxTotalNotional: limits.maxTotalNotional.toString(),
      maxDrawdownBps: Number(limits.maxDrawdownBps),
      maxMarkAgeSeconds: Number(limits.maxMarkAgeSeconds),
      venueLeverageHdths: Number(leverage),
      maxAdverseLimitBps: Number(band)
    },
    activity: summarizeAgentLog(agentLog()),
    readAt: Math.floor(Date.now() / 1000)
  };
}

// A cached reader: one read per ttl, concurrent callers share it, and a failed
// read is not cached so the next visitor retries.
export function createPerplReader({
  deployment = loadPerplDeployment(),
  provider = new JsonRpcProvider(PERPL_RPC, Number(deployment.chainId), { staticNetwork: true }),
  contract,
  agentLog,
  ttlMs = CACHE_MS,
  now = () => Date.now()
} = {}) {
  let cached = null;
  let pending = null;
  return async function read() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    pending ??= readPerpl({ deployment, provider, contract, ...(agentLog && { agentLog }) })
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

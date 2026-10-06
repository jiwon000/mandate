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

// The smoke run (docs/perpl-adapter.md, "Testnet deployment"). The first close,
// which ran out of gas, is left out.
export const SMOKE_TXS = [
  { label: "Open 0.001 BTC long", hash: "0x8bc37083404133d95c0920a5840934c2c014836d5735ca9b1cd9336a340e3ddd" },
  { label: "Close 0.001 BTC (resent, filled)", hash: "0x7a8fce78cc8349ef85f1a58f782c7b2608b1a5b05dbdaa2a2c248177ce958fd4" },
  { label: "Withdraw 149.914834 aUSD", hash: "0x97420fb0294c2a66386718d3a5e77c7e7234b3d5f3f237774b718f533f65bab8" }
];

export function loadPerplDeployment() {
  return JSON.parse(readFileSync(new URL("../contracts/deployments/perpl-10143.json", import.meta.url), "utf8"));
}

// Everything is stringified here: bigints do not survive JSON, and the page
// formats them (equity and assets are 6-decimal aUSD, notionals and prices e18).
export async function readPerpl({ deployment, provider, contract = (address, abi) => new Contract(address, abi, provider) }) {
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
    txs: SMOKE_TXS,
    readAt: Math.floor(Date.now() / 1000)
  };
}

// A cached reader: one read per ttl, concurrent callers share it, and a failed
// read is not cached so the next visitor retries.
export function createPerplReader({
  deployment = loadPerplDeployment(),
  provider = new JsonRpcProvider(PERPL_RPC, Number(deployment.chainId), { staticNetwork: true }),
  contract,
  ttlMs = CACHE_MS,
  now = () => Date.now()
} = {}) {
  let cached = null;
  let pending = null;
  return async function read() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    pending ??= readPerpl({ deployment, provider, contract })
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

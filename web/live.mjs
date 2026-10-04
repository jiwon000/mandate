// The demo against a live RPC: Monad testnet, or any node reachable over HTTP.
//
// The browser is unchanged. It still reads and writes through /rpc, still asks
// for `eth_accounts` and signs with `eth_sendTransaction`; this module answers
// those two calls itself (the keys are derived from DEMO_MNEMONIC and never
// leave the server) and forwards every read to the upstream RPC untouched. The
// price oracle that web/chain.mjs runs every block runs here as a transaction
// every few seconds, and only at that pace while somebody is looking.
import fs from "node:fs";
import path from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, formatEther, formatUnits, parseEther } from "ethers";
import { loadArtifact } from "../contracts/script/artifacts.mjs";
import { CONTRACT_SOURCES, START_PRICE, deployDemoSystem } from "./mandates.mjs";
import { demoWallets } from "./accounts.mjs";
import { authorise, buildPolicy } from "./live-policy.mjs";
import { ReadCache, rpcFailure, rpcResult, toRpcError } from "./rpc.mjs";

const root = path.resolve(import.meta.dirname, "..");

export const NETWORKS = {
  143: { label: "Monad mainnet", explorer: "https://monadscan.com" },
  10143: { label: "Monad testnet", explorer: "https://testnet.monadscan.com" },
  31337: { label: "Local node", explorer: null }
};
export const networkInfo = (chainId) => NETWORKS[chainId] ?? { label: `Chain ${chainId}`, explorer: null };
export const deploymentFileFor = (chainId) => path.join(root, "web/deployments", `${chainId}.json`);

export function loadAbis() {
  return Object.fromEntries(
    Object.entries(CONTRACT_SOURCES).map(([key, [source, name]]) => [key, loadArtifact(`${source}.sol`, name).abi])
  );
}

// Everything the page needs to read a chain. Anything else - signing methods,
// node administration, raw transaction relay - is refused at the proxy.
const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call",
  "eth_estimateGas", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getTransactionCount", "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "net_version", "web3_clientVersion"
]);

class TokenBucket {
  constructor(perMinute) {
    this.capacity = perMinute;
    this.tokens = perMinute;
    this.updated = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 60_000) * this.capacity);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const isNonceError = (error) => error?.code === "NONCE_EXPIRED" || /nonce/i.test(error?.message ?? "");

// Tops every demo account up to `perAccountMon` of gas from the owner. Only the
// shortfall is sent, so re-running is cheap.
export async function fundAccounts({ provider, wallets, owner, perAccountMon, log = () => {} }) {
  const target = parseEther(String(perAccountMon));
  const recipients = [wallets.allocator, ...wallets.agents, wallets.keeper];
  for (const wallet of recipients) {
    const balance = await provider.getBalance(wallet.address);
    if (balance >= target) continue;
    const value = target - balance;
    await (await owner.sendTransaction({ to: wallet.address, value })).wait();
    log(`funded ${wallet.address} with ${formatEther(value)} MON`);
  }
}

// Deploys the four-mandate system from the demo accounts and records it in
// web/deployments/<chainId>.json (addresses only; ABIs come from the artifacts).
export async function deployLiveSystem({ provider, wallets, signers, file, perAccountMon = 0.3, log = () => {} }) {
  await fundAccounts({ provider, wallets, owner: signers.owner, perAccountMon, log });
  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = loadArtifact(`${source}.sol`, name);
    const contract = await new ContractFactory(abi, bytecode, signers.owner).deploy(...args);
    await contract.waitForDeployment();
    log(`${name} ${await contract.getAddress()}`);
    return contract;
  };
  const abiOf = (source, name) => loadArtifact(`${source}.sol`, name).abi;
  const record = await deployDemoSystem({
    deploy, abiOf, provider,
    owner: signers.owner, allocator: signers.allocator, agents: signers.agents, keeper: signers.keeper,
    basePriceE18: START_PRICE, profile: "live", log
  });
  const { abis: _abis, ...rest } = record;
  const stored = { ...rest, deployedAt: new Date().toISOString(), network: networkInfo(rest.chainId) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  log(`wrote ${path.relative(root, file)}`);
  return stored;
}

export async function startLive({ rpcUrl, mnemonic, adminToken = "", deploymentFile, env = process.env, log = console.log }) {
  if (!rpcUrl) throw new Error("MONAD_RPC_URL is required in live mode");
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is required in live mode");
  const number = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : Number(env[key]));
  const config = {
    activeSeconds: number("ORACLE_ACTIVE_SECONDS", 5),
    idleSeconds: number("ORACLE_IDLE_SECONDS", 300),
    observeSeconds: number("ORACLE_OBSERVE_SECONDS", 30),
    presenceSeconds: number("PRESENCE_SECONDS", 60),
    autoReset: env.AUTO_RESET !== "0",
    autoResetMinFrozen: number("AUTO_RESET_MIN_FROZEN", 2),
    resetCooldownSeconds: number("RESET_COOLDOWN_SECONDS", 600),
    resetMinBalanceMon: number("RESET_MIN_BALANCE_MON", 3),
    gasPerAccountMon: number("DEMO_GAS_PER_ACCOUNT_MON", 0.3),
    maxGasPerTx: number("MAX_GAS_PER_TX", 1_500_000),
    sendPerMinute: number("SEND_TX_PER_MINUTE", 40),
    controlPerMinute: number("CONTROL_PER_MINUTE", 12),
    logLookbackBlocks: number("LOG_LOOKBACK_BLOCKS", 90),
    readCacheMs: number("READ_CACHE_MS", 2000)
  };

  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 500;
  const chainId = Number((await provider.getNetwork()).chainId);
  const file = deploymentFile ?? deploymentFileFor(chainId);
  const wallets = demoWallets(mnemonic, provider);
  // Local nonces for every account that sends: a load-balanced public RPC can
  // answer eth_getTransactionCount from a node that has not seen the last one.
  const signers = {
    owner: new NonceManager(wallets.owner),
    allocator: new NonceManager(wallets.allocator),
    agents: wallets.agents.map((w) => new NonceManager(w)),
    keeper: new NonceManager(wallets.keeper)
  };
  const abis = loadAbis();
  const sendBucket = new TokenBucket(config.sendPerMinute);
  const controlBucket = new TokenBucket(config.controlPerMinute);
  const reads = new ReadCache(config.readCacheMs);
  let forwarded = 0;

  let deployment = null;
  let policy = null;
  let hot = new Map();
  let venue = null;
  let guard = null;
  let vaults = [];

  function adopt(record) {
    if (Number(record.chainId) !== chainId) {
      throw new Error(`${file} is a chain ${record.chainId} deployment; the RPC is chain ${chainId}`);
    }
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const matches =
      same(record.accounts.allocator, wallets.allocator.address) &&
      same(record.accounts.keeper, wallets.keeper.address) &&
      record.vaults.every((v, i) => same(v.agent, wallets.agents[i].address));
    if (!matches) throw new Error("DEMO_MNEMONIC does not derive this deployment's accounts; run npm run deploy:demo");

    deployment = { ...record, abis, live: true, network: networkInfo(chainId) };
    policy = buildPolicy(deployment);
    hot = new Map([
      [wallets.allocator.address.toLowerCase(), signers.allocator],
      [wallets.keeper.address.toLowerCase(), signers.keeper],
      ...wallets.agents.map((w, i) => [w.address.toLowerCase(), signers.agents[i]])
    ]);
    venue = new Contract(deployment.addresses.venue, abis.venue, signers.owner);
    guard = new Contract(deployment.addresses.guard, abis.guard, signers.keeper);
    vaults = deployment.vaults.map((v) => new Contract(v.address, abis.vault, provider));
  }

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment at ${path.relative(root, file)}. Run \`npm run deploy:demo\` against this RPC first.`);
  }
  adopt(JSON.parse(fs.readFileSync(file, "utf8")));

  // --- presence and the oracle ----------------------------------------
  let basePriceE18 = START_PRICE;
  let pendingShockBps = 0;
  let lastTouch = 0;
  let wasActive = false;
  let lastPushAt = 0;
  let lastObserveAt = 0;
  let lastResetAt = 0;
  let ticks = 0;
  let pushes = 0;
  let spentWei = 0n;
  let lastError = null;
  let busy = false;

  const touch = () => { lastTouch = Date.now(); };
  const isActive = () => Date.now() - lastTouch < config.presenceSeconds * 1000;
  // Monad bills the gas limit, not the gas used, so that is what gets counted.
  const spend = (response, receipt) => { spentWei += response.gasLimit * (receipt.gasPrice ?? response.gasPrice ?? 0n); };

  async function send(contractCall) {
    const response = await contractCall;
    const receipt = await response.wait();
    spend(response, receipt);
    return receipt;
  }

  async function observeAll(why) {
    for (const vault of deployment.vaults) {
      if (Number(vault.limits.volWindowSeconds) === 0) continue;
      try {
        await send(guard.observe(vault.address, deployment.addresses.adapter));
      } catch (error) {
        log(`[observe:${why}] ${vault.key} ${error.shortMessage ?? error.message}`);
        if (isNonceError(error)) signers.keeper.reset();
      }
    }
    reads.clear();
    lastObserveAt = Date.now();
  }

  async function push() {
    ticks += 1;
    let shocked = false;
    if (pendingShockBps !== 0) {
      // Take the pre-shock mark first so the estimator sees the shock as one
      // return over a block or two, as it does on the in-process chain.
      if (isActive()) await observeAll("pre-shock");
      basePriceE18 = (basePriceE18 * BigInt(10_000 + pendingShockBps)) / 10_000n;
      pendingShockBps = 0;
      shocked = true;
    }
    const wobbleBps = Math.round(8 * Math.sin(ticks / 9));
    const priceE18 = (basePriceE18 * BigInt(10_000 + wobbleBps)) / 10_000n;
    await send(venue.setPrice(priceE18));
    reads.clear();
    pushes += 1;
    lastPushAt = Date.now();
    return shocked;
  }

  async function maybeAutoReset() {
    const states = await Promise.all(vaults.map((v) => v.state()));
    const frozen = states.filter((s) => s !== 0n).length;
    if (frozen < config.autoResetMinFrozen) return;
    if (Date.now() - lastResetAt < config.resetCooldownSeconds * 1000) return;
    const balance = await provider.getBalance(wallets.owner.address);
    if (balance < parseEther(String(config.resetMinBalanceMon))) {
      log(`[reset] skipped: ${frozen} vaults frozen but owner holds ${formatEther(balance)} MON`);
      return;
    }
    log(`[reset] ${frozen} vaults frozen and nobody watching: redeploying`);
    await redeploy("auto");
  }

  async function beat() {
    if (busy || !deployment) return;
    busy = true;
    try {
      const active = isActive();
      const justLeft = wasActive && !active;
      wasActive = active;
      if (justLeft && config.autoReset) await maybeAutoReset();

      const cadence = (active ? config.activeSeconds : config.idleSeconds) * 1000;
      const now = Date.now();
      if (pendingShockBps === 0 && now - lastPushAt < cadence) return;
      const shocked = await push();
      if (active && (shocked || now - lastObserveAt >= config.observeSeconds * 1000)) await observeAll("tick");
      lastError = null;
    } catch (error) {
      lastError = error.shortMessage ?? error.message;
      log(`[oracle] ${lastError}`);
      if (isNonceError(error)) { signers.owner.reset(); signers.keeper.reset(); }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(beat, 1000);

  async function redeploy(by) {
    lastResetAt = Date.now();
    basePriceE18 = START_PRICE;
    pendingShockBps = 0;
    lastPushAt = 0;
    lastObserveAt = 0;
    const stored = await deployLiveSystem({
      provider, wallets, signers, file, perAccountMon: config.gasPerAccountMon, log: (line) => log(`[deploy:${by}] ${line}`)
    });
    adopt(stored);
    reads.clear();
    // The cooldown counts from the end of a reset, not its start.
    lastResetAt = Date.now();
    return deployment;
  }

  // --- JSON-RPC ---------------------------------------------------------
  async function upstream(body) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`upstream RPC answered ${response.status}`);
    return response.json();
  }

  async function sendOnBehalf(id, tx) {
    const verdict = authorise(policy, tx);
    if (!verdict.ok) return rpcFailure(id, -32000, `refused: ${verdict.reason}`);
    if (!sendBucket.take()) return rpcFailure(id, -32005, "the demo is signing too many transactions; try again in a minute");
    const signer = hot.get(String(tx.from).toLowerCase());
    const request = { to: tx.to, data: tx.data ?? tx.input, value: 0n };
    try {
      // The browser's gas field is ignored: Monad charges the limit, so the
      // server estimates for itself and caps what one click can cost.
      const gas = await provider.estimateGas({ ...request, from: tx.from });
      if (gas > BigInt(config.maxGasPerTx)) return rpcFailure(id, -32000, `refused: gas ${gas} is above the demo cap`);
      const response = await signer.sendTransaction({ ...request, gasLimit: gas });
      response.wait().then((receipt) => { spend(response, receipt); reads.clear(); }).catch(() => signer.reset());
      touch();
      log(`[sign] ${verdict.role} ${verdict.name} -> ${response.hash}`);
      return rpcResult(id, response.hash);
    } catch (error) {
      if (isNonceError(error)) signer.reset();
      const rpcError = toRpcError(error);
      return { jsonrpc: "2.0", id, error: rpcError };
    }
  }

  async function handleOne(call) {
    const id = call?.id ?? null;
    const method = call?.method;
    if (method === "eth_accounts") return rpcResult(id, policy.accounts);
    if (method === "eth_sendTransaction") return sendOnBehalf(id, (call.params ?? [])[0]);
    if (!READ_METHODS.has(method)) return rpcFailure(id, -32601, `${method} is not available through the demo proxy`);
    return null;
  }

  async function handleRpc(payload) {
    touch();
    const calls = Array.isArray(payload) ? payload : [payload];
    const results = new Array(calls.length);
    const forward = [];
    for (const [index, call] of calls.entries()) {
      const handled = (await handleOne(call)) ?? reads.get(call);
      if (handled) results[index] = handled;
      else forward.push(index);
    }
    if (forward.length) {
      forwarded += forward.length;
      try {
        const answers = await upstream(forward.map((index) => calls[index]));
        const byId = new Map((Array.isArray(answers) ? answers : [answers]).map((a) => [a.id, a]));
        for (const index of forward) {
          results[index] = byId.get(calls[index].id) ?? rpcFailure(calls[index].id ?? null, -32603, "no answer from upstream");
        }
        // A mined receipt passing through means the state the cache holds is
        // from before that transaction; the browser that sent it is about to
        // re-read everything and must not get the old answers.
        if (forward.some((index) => calls[index].method === "eth_getTransactionReceipt" && results[index].result)) reads.clear();
        for (const index of forward) reads.put(calls[index], results[index]);
      } catch (error) {
        for (const index of forward) results[index] = rpcFailure(calls[index].id ?? null, -32603, error.message);
      }
    }
    return Array.isArray(payload) ? results : results[0];
  }

  const control = {
    async status() {
      const [priceE18, markedAt, block, balance] = await Promise.all([
        venue.priceE18(), venue.updatedAt(), provider.getBlock("latest"), provider.getBalance(wallets.owner.address)
      ]);
      const active = isActive();
      const cadenceSeconds = active ? config.activeSeconds : config.idleSeconds;
      return {
        live: true,
        blockTimeSeconds: null,
        priceE18: priceE18.toString(),
        markedAt: Number(markedAt),
        chainTime: Number(block.timestamp),
        basePrice: formatUnits(basePriceE18, 18),
        oracle: {
          active,
          cadenceSeconds,
          observeSeconds: config.observeSeconds,
          lastPushAt,
          nextPushInSeconds: lastPushAt ? Math.max(0, Math.round((lastPushAt + cadenceSeconds * 1000 - Date.now()) / 1000)) : 0,
          pushes,
          spentMon: formatEther(spentWei),
          lastError
        },
        deployer: { address: wallets.owner.address, balanceMon: formatEther(balance) },
        proxy: { forwarded, cached: reads.hits, cacheMs: config.readCacheMs },
        reset: { admin: Boolean(adminToken), auto: config.autoReset, lastResetAt }
      };
    },
    setBlockTime() {
      throw new Error("block time is the chain's own on a live network");
    },
    shock(bps) {
      if (!controlBucket.take()) throw new Error("too many market moves; wait a minute");
      const value = Math.trunc(Number(bps));
      if (!Number.isFinite(value) || Math.abs(value) > 3000) throw new Error("shock out of range");
      touch();
      pendingShockBps = value;
      return { pendingShockBps };
    },
    restorePrice() {
      if (!controlBucket.take()) throw new Error("too many market moves; wait a minute");
      touch();
      basePriceE18 = START_PRICE;
      pendingShockBps = 0;
      lastPushAt = 0; // push on the next beat
      return { basePrice: formatUnits(basePriceE18, 18) };
    },
    async redeploy(token) {
      if (!adminToken || String(token ?? "") !== adminToken) {
        throw new Error("reset needs the admin token on a live network");
      }
      if (Date.now() - lastResetAt < config.resetCooldownSeconds * 1000) {
        throw new Error(`reset cooldown: ${Math.ceil((lastResetAt + config.resetCooldownSeconds * 1000 - Date.now()) / 1000)}s left`);
      }
      await redeploy("admin");
      return { ok: true, startedAt: deployment.startedAt };
    }
  };

  log(`live mode on ${deployment.network.label} (chain ${chainId}); oracle ${config.activeSeconds}s while watched, ${config.idleSeconds}s idle`);

  return {
    live: true,
    // The page scans logs from startBlock. Near the tip, not the deployment
    // block: a getLogs over days of testnet blocks is refused by public RPCs.
    deployment: async () => {
      const latest = await provider.getBlockNumber();
      return { ...deployment, startBlock: Math.max(deployment.startBlock, latest - config.logLookbackBlocks) };
    },
    handleRpc,
    control,
    touch,
    async close() {
      clearInterval(timer);
      provider.destroy();
    }
  };
}

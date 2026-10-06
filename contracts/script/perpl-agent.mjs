// A small trading agent for the Mandate vault that deploy-perpl.mjs put on Perpl's
// testnet exchange. It is a simple rule-based script, NOT an AI model: it follows an
// exponential moving average of the BTC mark, holds a small long above it and a small
// short below it. Its purpose is to show a mandate bounding an autonomous agent on a
// real venue: every few ticks it deliberately sends an order past the vault's $200
// position cap, and the guard refuses it on chain with a named error.
//
//   npm run agent:perpl
//
// The agent key is the deployer's, and is read as in deploy-perpl.mjs: PERPL_DEPLOYER_KEY,
// or the `privateKey` field of the JSON file at PERPL_WALLET_FILE. It is never printed or
// logged. PERPL_DEPLOYMENTS points at the deployment JSON (default
// contracts/deployments/perpl-10143.json). MONAD_RPC_URL defaults to the public testnet
// RPC; the script refuses any chain but 10143, so a local fork started with
// `npx hardhat node --fork <rpc> --chain-id 10143` is how it was rehearsed.
//
// Settings, all environment variables:
//   ALLOCATE        aUSD to allocate if the wallet holds no vault shares (default off;
//                   Perpl opens an account only with 100 or more, 150 is a good choice)
//   TICK_SECONDS    seconds between ticks (default 300)
//   MAX_TICKS       ticks to run (default 12)
//   TARGET_BTC      position size to hold (default 0.001), cut so it stays under TARGET_USD
//   TARGET_USD      notional ceiling for the target position (default 100, cap is 200)
//   MIN_DELTA_USD   skip an order smaller than this (default 10)
//   EMA_TICKS       the EMA's span in ticks (default 5)
//   BREACH_EVERY    every Nth tick, try an order past the position cap; 0 disables (default 4)
//   SEND_BREACH     1 sends the refused order on chain so the refusal is recorded (default 1)
//   BREACH_GAS      fixed gas limit for that order; by default the lowest of 400k, 450k, 500k,
//                   600k, 750k, 1M at which a static call still names the guard's error
//   CLOSE_ON_EXIT   1 closes any open position at the end or on Ctrl-C (default 1)
//   MIN_MON         stop early if the wallet falls below this much MON (default 0.3)
//   AGENT_LOG       JSON lines log (default contracts/deployments/perpl-agent-10143.jsonl)
//
// Monad charges the gas LIMIT, not the gas used, so every transaction here is sent with
// a limit close to what it needs, and a tick sends at most two.
import fs from "node:fs";
import path from "node:path";
import {
  AbiCoder, Contract, Interface, JsonRpcProvider, NonceManager, Wallet,
  formatEther, formatUnits, parseUnits
} from "ethers";
import { loadAbi } from "./artifacts.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const BTC_PERP_ID = 16; // the mandate's market 0
const MAX_MARK_AGE = 60; // seconds, the mandate's term and Perpl's own bound
const POSITION_CAP_USD = 200; // the mandate's maxPositionNotional
const BREACH_GAS_LADDER = [400_000n, 450_000n, 500_000n, 600_000n, 750_000n, 1_000_000n];
const e18 = (x) => parseUnits(String(x), 18);
const coder = AbiCoder.defaultAbiCoder();

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const {
  MONAD_RPC_URL = "https://testnet-rpc.monad.xyz",
  PERPL_DEPLOYER_KEY,
  PERPL_WALLET_FILE,
  PERPL_DEPLOYMENTS = path.join(root, "contracts/deployments/perpl-10143.json"),
  AGENT_LOG = path.join(root, "contracts/deployments/perpl-agent-10143.jsonl"),
  ALLOCATE = "",
  TICK_SECONDS = "300",
  MAX_TICKS = "12",
  TARGET_BTC = "0.001",
  TARGET_USD = "100",
  MIN_DELTA_USD = "10",
  EMA_TICKS = "5",
  BREACH_EVERY = "4",
  SEND_BREACH = "1",
  BREACH_GAS = "",
  CLOSE_ON_EXIT = "1",
  MIN_MON = "0.3"
} = process.env;

function agentKey() {
  if (PERPL_DEPLOYER_KEY) return PERPL_DEPLOYER_KEY;
  if (PERPL_WALLET_FILE) return JSON.parse(fs.readFileSync(PERPL_WALLET_FILE, "utf8")).privateKey;
  throw new Error("Set PERPL_DEPLOYER_KEY, or PERPL_WALLET_FILE to a JSON file with a privateKey field");
}

const provider = new JsonRpcProvider(MONAD_RPC_URL);
const wallet = new Wallet(agentKey(), provider);
const signer = new NonceManager(wallet); // local nonces, as in deploy-perpl.mjs
const { chainId } = await provider.getNetwork();
if (chainId !== 10143n) throw new Error(`Chain ${chainId} is not Monad testnet (10143)`);

const d = JSON.parse(fs.readFileSync(PERPL_DEPLOYMENTS, "utf8"));
const vaultAbi = loadAbi("MandateVault.sol", "MandateVault");
const adapterAbi = loadAbi("perpl/PerplAdapter.sol", "PerplAdapter");
const vault = new Contract(d.vault, vaultAbi, signer);
const adapter = new Contract(d.PerplAdapter, adapterAbi, provider);
const exchange = new Contract(d.perpl.exchange, loadAbi("perpl/IPerplExchange.sol", "IPerplExchange"), provider);
const ausd = new Contract(AUSD, ERC20, provider);
// The refusal can come from the guard, the vault or the adapter; decode against all three.
const errors = new Interface([
  ...loadAbi("MandateRiskGuard.sol", "MandateRiskGuard"), ...vaultAbi, ...adapterAbi
].filter((item) => item.type === "error"));

const num = (x) => Number(formatUnits(x, 18));
const ticks = Number(MAX_TICKS);
const tickMs = Number(TICK_SECONDS) * 1000;
const breachEvery = Number(BREACH_EVERY);
const alpha = 2 / (Number(EMA_TICKS) + 1);
const minMon = parseUnits(MIN_MON, 18);
const startMon = await provider.getBalance(wallet.address);

fs.mkdirSync(path.dirname(AGENT_LOG), { recursive: true });
const log = (event) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...event });
  console.log(line);
  fs.appendFileSync(AGENT_LOG, `${line}\n`);
};

let stopping = false;
let wake = null;
process.on("SIGINT", () => { stopping = true; wake?.(); });
const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  wake = () => { clearTimeout(timer); resolve(); };
});

// The adapter's positionState is unsigned, so read the signed size from preview(): the
// size after a one-lot order, less the lot.
async function signedSize() {
  const info = await exchange.getPerpetualInfoV2(BTC_PERP_ID);
  const lot = 10n ** (18n - info.lotDecimals);
  const order = coder.encode(["int256", "uint256"], [lot, 1n]);
  return { size: (await adapter.preview(d.vault, order)).resultingSizeE18 - lot, lot };
}

async function read() {
  const [mark, markedAt] = await adapter.marketPrice(0);
  const latest = await provider.getBlock("latest");
  // Perpl and the guard measure the mark's age against block time, so does the agent.
  return { mark, age: latest.timestamp - Number(markedAt) };
}

const roundToLot = (size, lot) => (size / lot) * lot; // toward zero

// An order whose limit is 1% past the mark on the costly side, inside the 3% band.
const orderArgs = (sizeE18, mark) => {
  const limit = sizeE18 > 0n ? (mark * 101n) / 100n : (mark * 99n) / 100n;
  return [d.PerplAdapter, coder.encode(["int256", "uint256"], [sizeE18, limit])];
};

// The revert data of a failed call or send, as ethers or a local node reports it.
const revertData = (error) => [error?.data, error?.info?.error?.data, error?.error?.data]
  .find((data) => typeof data === "string" && data.length >= 10);

function decode(error) {
  const data = revertData(error);
  if (data) {
    const parsed = errors.parseError(data);
    return parsed ? `${parsed.name}(${parsed.args.join(",")})` : `unknown error ${data.slice(0, 10)}`;
  }
  return error?.revert?.name ?? error?.shortMessage ?? String(error?.message ?? error).slice(0, 120);
}

// The node's estimate can fall short inside Perpl's exchange (see deploy-perpl.mjs);
// half again as much gas is enough.
async function trade(sizeE18, mark) {
  const args = orderArgs(sizeE18, mark);
  const gasLimit = ((await vault.execute.estimateGas(...args)) * 3n) / 2n;
  const receipt = await (await vault.execute(...args, { gasLimit })).wait();
  return { tx: receipt.hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() };
}

// An order that takes the position past the $200 cap, in the direction it already
// leans. The guard refuses it from preview() alone, so a static call shows the error;
// sending it with a fixed gas limit records the refusal on chain.
async function breach(size, lot, mark, lean) {
  const dir = size !== 0n ? (size > 0n ? 1n : -1n) : lean;
  const extraBtc = (POSITION_CAP_USD + 30) / num(mark); // about $230 more
  const delta = dir * roundToLot(e18(extraBtc.toFixed(8)), lot);
  const args = orderArgs(delta, mark);
  const out = { notionalUsd: Math.round(Math.abs(num(size + delta)) * num(mark)) };
  // A refusal needs gas for preview() and the guard's reads of Perpl before it reverts,
  // and Monad prices cold reads higher than other chains do. So ask the node, with
  // static calls at rising gas limits, for the lowest limit at which the revert still
  // names the guard's error, and send with that. Static calls cost nothing.
  let gasLimit = null;
  for (const gas of BREACH_GAS ? [BigInt(BREACH_GAS)] : BREACH_GAS_LADDER) {
    try {
      await vault.execute.staticCall(...args, { gasLimit: gas });
      out.warning = "static call did not revert, order not sent";
      return out;
    } catch (error) {
      const data = revertData(error);
      if (data && errors.parseError(data)) {
        out.error = decode(error);
        gasLimit = gas;
        break;
      }
    }
  }
  if (!gasLimit) {
    out.warning = "no gas limit tried got a named refusal, order not sent";
    return out;
  }
  if (SEND_BREACH !== "1") return out;
  out.gasLimit = gasLimit.toString();
  try {
    const receipt = await (await vault.execute(...args, { gasLimit })).wait();
    Object.assign(out, { tx: receipt.hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
  } catch (error) {
    // On Monad a reverted transaction is mined, and its receipt is the refusal on chain.
    // A local node refuses it when it is sent instead; reset the nonce it never used.
    const receipt = error?.receipt;
    if (!receipt) {
      signer.reset();
      out.status = "refused at send (local node)";
      return out;
    }
    Object.assign(out, { tx: receipt.hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
  }
  return out;
}

console.log(`Agent ${wallet.address} on chain ${chainId}, vault ${d.vault}`);
console.log(`  ${formatEther(startMon)} MON, ${formatUnits(await ausd.balanceOf(wallet.address), 6)} aUSD`);

if ((await vault.balanceOf(wallet.address)) === 0n && ALLOCATE) {
  const amount = parseUnits(ALLOCATE, 6);
  if (amount < parseUnits("100", 6)) throw new Error("Perpl opens an account only with 100 aUSD or more");
  const held = await ausd.balanceOf(wallet.address);
  if (held < amount) throw new Error(`Need ${ALLOCATE} aUSD, wallet holds ${formatUnits(held, 6)}`);
  const approve = await (await ausd.connect(signer).approve(d.vault, amount)).wait();
  const allocate = await (await vault.allocate(amount, wallet.address)).wait();
  log({ kind: "allocate", aUSD: ALLOCATE, approveTx: approve.hash, allocateTx: allocate.hash });
}

let ema = null;
let lean = 1n; // long until the mark first closes below its EMA
for (let n = 1; n <= ticks && !stopping; n++) {
  const event = { kind: "tick", tick: n };
  try {
    // A failed read here (the RPC or DNS dropping for a moment) skips the tick like any
    // other error, instead of ending the run with a position still open.
    const monLeft = await provider.getBalance(wallet.address);
    event.spentMon = formatEther(startMon - monLeft);
    if (monLeft < minMon) {
      log({ kind: "stop", reason: `MON ${formatEther(monLeft)} below MIN_MON ${MIN_MON}`, spentMon: event.spentMon });
      break;
    }
    const { mark, age } = await read();
    const m = num(mark);
    event.mark = m;
    event.markAge = age;
    if (age > MAX_MARK_AGE) {
      event.action = "skip stale mark";
    } else {
      const { size, lot } = await signedSize();
      ema = ema === null ? m : ema + alpha * (m - ema);
      event.ema = ema;
      event.positionBefore = num(size);
      if (m > ema) lean = 1n;
      else if (m < ema) lean = -1n;
      // Size the target so its notional stays under TARGET_USD, well under the cap.
      const targetBtc = Math.min(Number(TARGET_BTC), Number(TARGET_USD) / m);
      const wanted = lean * roundToLot(e18(targetBtc.toFixed(8)), lot);
      const delta = wanted - size;
      event.target = num(wanted);
      if (Math.abs(num(delta)) * m < Number(MIN_DELTA_USD)) {
        event.action = "hold";
      } else {
        event.action = delta > 0n ? "buy" : "sell";
        event.orderBtc = num(delta);
        try {
          Object.assign(event, await trade(delta, mark));
        } catch (error) {
          event.action = "order failed";
          event.error = decode(error);
        }
      }
      const after = await signedSize();
      event.positionAfter = num(after.size);
      if (breachEvery > 0 && n % breachEvery === 0 && !stopping) {
        const fresh = await read();
        event.breach = fresh.age > MAX_MARK_AGE
          ? { warning: "stale mark, breach not tried" }
          : await breach(after.size, after.lot, fresh.mark, lean);
      }
    }
  } catch (error) {
    event.action = "error";
    event.error = decode(error);
  }
  log(event);
  if (n < ticks && !stopping) await sleep(tickMs);
}

// The close is retried a few times, so a short network drop at the end does not leave
// the position open.
for (let attempt = 1; CLOSE_ON_EXIT === "1" && attempt <= 5; attempt++) {
  const event = { kind: "exit", action: "close", attempt };
  try {
    const { size } = await signedSize();
    event.positionBefore = num(size);
    if (size === 0n) {
      event.action = "flat";
    } else {
      // Perpl refuses a stale mark, so give a stale feed a little while to move.
      let fresh = await read();
      for (let i = 0; i < 12 && fresh.age > MAX_MARK_AGE; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        fresh = await read();
      }
      event.mark = num(fresh.mark);
      Object.assign(event, await trade(-size, fresh.mark));
    }
    event.positionAfter = num((await signedSize()).size);
  } catch (error) {
    event.action = "close failed";
    event.error = decode(error);
  }
  log(event);
  if (event.action !== "close failed") break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
try {
  const [equity] = await adapter.markEquity(d.vault);
  log({
    kind: "end", vaultEquityAUSD: formatUnits(equity, 6),
    spentMon: formatEther(startMon - (await provider.getBalance(wallet.address)))
  });
} catch (error) {
  log({ kind: "end", error: decode(error) });
}

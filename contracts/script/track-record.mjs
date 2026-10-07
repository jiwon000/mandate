// Prints a vault's track record from chain events (see contracts/tools/track-record.mjs).
//
// Usage: npm run track-record -- [vault] [--from-block N] [--to-block N] [--chunk N] [--table]
// Read-only. Without a vault address it covers every vault in the deployment file.
// The RPC comes from MONAD_RPC_URL or RPC_URL (default: the public Monad testnet);
// the guard, start block and vault list from web/deployments/<chainId>.json.
// The public RPC caps eth_getLogs per call and rate-limits, so scan a short range
// (--from-block) and keep --chunk modest.
import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, getAddress } from "ethers";
import { trackRecord } from "../tools/track-record.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const rpc = process.env.MONAD_RPC_URL || process.env.RPC_URL || "https://testnet-rpc.monad.xyz";

function parseArgs(argv) {
  const out = { vault: null, fromBlock: null, toBlock: null, chunk: 100, table: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-block") out.fromBlock = Number(argv[++i]);
    else if (a === "--to-block") out.toBlock = Number(argv[++i]);
    else if (a === "--chunk") out.chunk = Number(argv[++i]);
    else if (a === "--table") out.table = true;
    else if (/^0x[0-9a-fA-F]{40}$/.test(a)) out.vault = getAddress(a);
    else throw new Error(`Unknown argument ${a}`);
  }
  for (const key of ["fromBlock", "toBlock", "chunk"]) {
    if (out[key] !== null && !Number.isInteger(out[key])) throw new Error(`--${key} needs an integer`);
  }
  return out;
}

const iso = (t) => (t ? new Date(t * 1000).toISOString() : "-");

function printTable(name, r) {
  console.log(`\n${name}  ${r.vault}  blocks ${r.fromBlock}..${r.toBlock}`);
  const rows = [
    ["state", r.state ? `${r.state}${r.freezeReason && r.freezeReason !== "none" ? ` (${r.freezeReason})` : ""}` : "-"],
    ["marks", `${r.marks}  ${iso(r.firstMarkTime)} .. ${iso(r.lastMarkTime)}`],
    ["NAV/share", `${r.navPerShareFirst ?? "-"} -> ${r.navPerShareLast ?? "-"}  (${r.returnPct ?? "-"}%)`],
    ["max drawdown", `${r.maxDrawdownBps} bps of ${r.drawdownLimitBps ?? "?"} bps limit`],
    ["trades", r.trades],
    ["deposits / withdrawals", `${r.deposits} / ${r.withdrawals}`],
    ["fees (mgmt / perf)", `${r.fees.management} / ${r.fees.performance}`],
    ["breaches", r.breaches.length]
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(24)}${v}`);
  for (const b of r.breaches) console.log(`    ${b.type} ${iso(b.time)} block ${b.block} ${b.txHash}`);
}

const args = parseArgs(process.argv.slice(2));
const provider = new JsonRpcProvider(rpc);
const chainId = Number((await provider.getNetwork()).chainId);
const file = path.join(root, "web/deployments", `${chainId}.json`);
if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}`);
const record = JSON.parse(fs.readFileSync(file, "utf8"));

const known = (address) => record.vaults.find((v) => v.address.toLowerCase() === address.toLowerCase());
const vaults = args.vault
  ? [{ name: known(args.vault)?.name ?? args.vault, address: args.vault }]
  : record.vaults.map((v) => ({ name: v.name, address: v.address }));

const results = [];
for (const v of vaults) {
  const r = await trackRecord(provider, {
    guard: record.addresses.guard,
    vault: v.address,
    fromBlock: args.fromBlock ?? record.startBlock,
    toBlock: args.toBlock ?? undefined,
    chunk: args.chunk
  });
  results.push({ name: v.name, ...r });
}

if (args.table) for (const r of results) printTable(r.name, r);
else console.log(JSON.stringify(args.vault ? results[0] : results, null, 2));
provider.destroy();

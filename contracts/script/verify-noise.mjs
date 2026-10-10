// Checks a DP leaderboard release against the noise-seed pledge MandateRegistry
// holds for it (README, "Privacy model"). Read-only; never sends a transaction.
//
// Usage: node contracts/script/verify-noise.mjs [--epoch N] [--registry 0x..] [--rpc URL]
//          [--published release.json] [--seed 0x..] [--returns returns.json --nav nav.json]
//
// Without --seed this is the public check anyone can run: the release is on
// chain, a pledge was bound to it, and when the pledge landed relative to the
// window of data it covers. Given the server's published numbers (--published:
// the `lastRelease` object of GET /api/reporter, or its `published` part, saved
// to a file) it also checks that their digest is the one anchored on chain and
// that the pledge the server claims is the one the chain holds.
//
// With --seed, handed over by the reporter's operator out of band, it is an
// audit: keccak256(seed) must open the pledge, and the noise the seed produces
// is recomputed. With --returns and --nav (JSON arrays: the window's clipped
// inputs) the whole release is recomputed and compared with the digest. This
// mode de-noises the release -- the output shows the exact aggregate -- so it
// is for the auditor, never for the public.
//
// Exit code 0 when the release is verified, 1 when it is not or cannot be, 2 on
// a usage error. The RPC comes from MONAD_RPC_URL or RPC_URL (default: the
// public Monad testnet); the registry from web/deployments/<chainId>.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, JsonRpcProvider, ZeroHash, getAddress, getBytes, keccak256 } from "ethers";
import { laplaceSamples } from "../../reporter/noise.mjs";
import { clip, laplaceScaleForMean, maxDrawdown, mean, sharpe } from "../../reporter/stats.mjs";

const REGISTRY_ABI = [
  "function hasReleased() view returns (bool)",
  "function lastEpoch() view returns (uint256)",
  "function releaseOf(uint256) view returns (uint256 pinnedBlock, bytes32 statsDigest, uint256 epsilonPerfE6, uint256 epsilonIntentE6, uint256 cumulativeEpsilonE6)",
  "function noiseCommitOf(uint256) view returns (bytes32 commitment, uint64 committedAtBlock, uint64 windowStartBlock)"
];

const coder = AbiCoder.defaultAbiCoder();
const FIXED_POINT = 1_000_000;
const toFixedE6 = (value) => BigInt(Math.round(value * FIXED_POINT));

/// The same encoding reporter/reporter.mjs hashes into `statsDigest`.
export function statsDigestOf({ statsVersion, noisyMean, noisySharpe, noisyMaxDrawdown, sampleSize }) {
  return keccak256(
    coder.encode(
      ["uint256", "int256", "int256", "uint256", "uint256"],
      [BigInt(statsVersion), toFixedE6(noisyMean), toFixedE6(noisySharpe), toFixedE6(noisyMaxDrawdown), BigInt(sampleSize)]
    )
  );
}

/// Pure: chain state in, checks out. `release` and `noiseCommit` are what
/// MandateRegistry.releaseOf(epoch) and noiseCommitOf(epoch) return (null for
/// a registry that has no pledges); `published` is the reporter's published
/// object; `seed` (0x hex), `returns` and `nav` are the audit inputs.
export function verifyNoise({ release, noiseCommit, published = null, seed = null, returns = null, nav = null }) {
  const checks = [];
  const note = (name, ok, detail, hard = true) => checks.push({ name, ok, detail, hard });
  const audit = {};

  const posted = release && release.statsDigest !== ZeroHash;
  note("release posted", posted, posted ? `digest ${release.statsDigest}, pinned at block ${release.pinnedBlock}` : "no release for this epoch");

  const commitment = noiseCommit?.commitment ?? ZeroHash;
  const pledged = commitment !== ZeroHash;
  note(
    "pledge bound",
    pledged,
    pledged
      ? `commitment ${commitment}, pledged at block ${noiseCommit.committedAtBlock}`
      : noiseCommit
        ? "the release was posted without a pledge"
        : "this registry has no pledges (deployed before commitNoiseSeed existed)"
  );

  if (posted && pledged) {
    const at = Number(noiseCommit.committedAtBlock);
    const start = Number(noiseCommit.windowStartBlock);
    const pin = Number(release.pinnedBlock);
    const beforePin = pin - at;
    note(
      "pledge timing",
      beforePin > 0,
      beforePin > 0
        ? `pledged ${at - start} blocks into the window (${start}, ${pin}], ${beforePin} blocks before the data was pinned`
        : `pledged in the pinned block or after it (block ${at}, pin ${pin}): the pledge binds the reporter but did not precede the window's data`,
      false
    );
  }

  if (published) {
    if (published.epoch !== undefined && release?.epoch !== undefined) {
      note("published epoch", BigInt(published.epoch) === BigInt(release.epoch), `published ${published.epoch}, asked for ${release.epoch}`);
    }
    const stats = published.published ?? published;
    const digest = statsDigestOf(stats);
    note("published digest", posted && digest === release.statsDigest, posted ? `${digest} recomputed from the published numbers` : "no release to compare with");
    if (posted) {
      const epsilonE6 = toFixedE6(stats.epsilon);
      note("published epsilon", epsilonE6 === BigInt(release.epsilonPerfE6), `${stats.epsilon} published, ${release.epsilonPerfE6} e-6 anchored`);
    }
    if (stats.noiseCommit !== undefined) {
      // A pledge the server names but the chain does not hold contradicts no
      // number; it leaves the release without a pledge to answer to.
      note("published pledge", pledged && stats.noiseCommit === commitment, pledged ? `${stats.noiseCommit} published` : "the server names a pledge the chain does not hold", pledged);
    }

    if (seed) {
      const seedBytes = getBytes(seed);
      const opens = keccak256(seedBytes) === commitment;
      note("seed opens pledge", pledged && opens, opens ? "keccak256(seed) is the bound commitment" : `keccak256(seed) = ${keccak256(seedBytes)}`);
      const scale = laplaceScaleForMean(stats.clipBound, stats.sampleSize, stats.epsilon);
      note("noise scale", Math.abs(scale - stats.scale) < 1e-15, `2*${stats.clipBound}/(${stats.sampleSize}*${stats.epsilon}) = ${scale}`);
      const noise = laplaceSamples(Buffer.from(seedBytes), 3, scale);
      audit.noise = { mean: noise[0], sharpe: noise[1], maxDrawdown: noise[2] };
      audit.exact = {
        mean: stats.noisyMean - noise[0],
        sharpe: stats.noisySharpe - noise[1],
        // The published drawdown is clamped to [0, 1]; the subtraction only
        // recovers the real value when the clamp did not bind.
        maxDrawdown: stats.noisyMaxDrawdown - noise[2]
      };
      if (returns && nav) {
        const clipped = returns.map((r) => clip(r, stats.clipBound));
        const recomputed = statsDigestOf({
          statsVersion: stats.statsVersion,
          noisyMean: mean(clipped) + noise[0],
          noisySharpe: sharpe(clipped) + noise[1],
          noisyMaxDrawdown: Math.min(1, Math.max(0, maxDrawdown(nav) + noise[2])),
          sampleSize: clipped.length
        });
        note("sample size", clipped.length === stats.sampleSize, `${clipped.length} returns given, ${stats.sampleSize} published`);
        note("recomputed digest", posted && recomputed === release.statsDigest, `${recomputed} from the seed and the given inputs`);
      }
    }
  }

  let verdict = "verified";
  if (checks.some((c) => c.hard && !c.ok && c.name !== "release posted" && c.name !== "pledge bound")) verdict = "mismatch";
  else if (!posted || !pledged) verdict = "unverifiable";
  else if (checks.some((c) => !c.hard && !c.ok)) verdict = "late-pledge";
  return { verdict, checks, audit: seed ? audit : null };
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const out = { epoch: null, registry: null, rpc: null, published: null, seed: null, returns: null, nav: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--epoch") out.epoch = Number(argv[++i]);
    else if (a === "--registry") out.registry = getAddress(argv[++i]);
    else if (a === "--rpc") out.rpc = argv[++i];
    else if (a === "--published") out.published = argv[++i];
    else if (a === "--seed") out.seed = argv[++i];
    else if (a === "--returns") out.returns = argv[++i];
    else if (a === "--nav") out.nav = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (out.epoch !== null && !Number.isInteger(out.epoch)) throw new Error("--epoch needs an integer");
  if (out.seed !== null && !/^0x[0-9a-fA-F]{64}$/.test(out.seed)) throw new Error("--seed needs 32 bytes as 0x hex");
  if (out.seed !== null && out.published === null) throw new Error("--seed needs --published (the release's numbers)");
  if ((out.returns === null) !== (out.nav === null)) throw new Error("--returns and --nav go together");
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const root = path.resolve(import.meta.dirname, "../..");
  const rpc = args.rpc || process.env.MONAD_RPC_URL || process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
  const provider = new JsonRpcProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  let registryAddress = args.registry;
  if (!registryAddress) {
    const file = path.join(root, "web/deployments", `${chainId}.json`);
    if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}; pass --registry`);
    registryAddress = readJson(file).registry.address;
  }
  const registry = new Contract(registryAddress, REGISTRY_ABI, provider);

  if (!(await registry.hasReleased())) {
    console.log(`registry ${registryAddress} on chain ${chainId}: no release posted yet`);
    process.exit(1);
  }
  const epoch = args.epoch ?? Number(await registry.lastEpoch());
  const onChain = await registry.releaseOf(epoch);
  const release = { epoch, ...onChain.toObject() };
  let noiseCommit = null;
  try {
    noiseCommit = (await registry.noiseCommitOf(epoch)).toObject();
  } catch (error) {
    if (error?.code !== "BAD_DATA" && error?.code !== "CALL_EXCEPTION") throw error;
  }
  const published = args.published ? readJson(args.published) : null;
  const returns = args.returns ? readJson(args.returns) : null;
  const nav = args.nav ? readJson(args.nav) : null;

  const result = verifyNoise({ release, noiseCommit, published, seed: args.seed, returns, nav });
  console.log(`registry ${registryAddress} on chain ${chainId}, epoch ${epoch}`);
  for (const c of result.checks) console.log(`  ${c.ok ? "ok  " : c.hard ? "FAIL" : "late"}  ${c.name.padEnd(18)}${c.detail}`);
  if (result.audit) {
    console.log("\n  AUDIT MODE: the lines below de-noise this release. They show the exact");
    console.log("  aggregate the epsilon guarantee exists to hide. Do not publish them.");
    const n = result.audit.noise;
    const e = result.audit.exact;
    console.log(`  noise   mean ${n.mean}  sharpe ${n.sharpe}  maxDrawdown ${n.maxDrawdown}`);
    console.log(`  exact   mean ${e.mean}  sharpe ${e.sharpe}  maxDrawdown ${e.maxDrawdown} (if the [0,1] clamp did not bind)`);
  }
  console.log(`\nverdict: ${result.verdict}`);
  process.exit(result.verdict === "verified" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

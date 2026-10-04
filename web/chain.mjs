// Boots an in-process EDR chain, deploys the real Mandate contracts onto it, and
// keeps a price oracle stamping marks at a configurable block cadence.
//
// This is the demo's chain. Nothing here is mocked at the UI layer: the browser
// talks to these contracts over JSON-RPC and every number it renders is read back
// from contract state. The mandates themselves, and the routine that deploys and
// seeds them, live in ./mandates.mjs and are shared with the live-RPC deploy.
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, formatUnits, getAddress, verifyTypedData, ZeroHash } from "ethers";
import { artifact, compileContracts } from "../contracts/tools/compiler.mjs";
import { START_PRICE, deployDemoSystem } from "./mandates.mjs";
import { buildIntentTree, hashIntent, intentDomain, intentTypes } from "../contracts/tools/batch.mjs";
import { DPReporter } from "../reporter/reporter.mjs";

// Short enough that a live demo sees an epoch end and settle inside one
// session; the privileged settleEpoch() call still only nets signed intents,
// it never picks who gets how many shares (BatchAllocator.sol _allocate()).
const BATCH_EPOCH_SECONDS = 20;
const BATCH_SETTLEMENT_WINDOW_SECONDS = 600;

// DP release tuning for the demo. "epoch" here is just a strictly-increasing
// release counter, not a wall-clock window like BatchAllocator's -- the spec
// only requires epoch/pinnedBlock to advance, and giving the Reporter its own
// clock (mandate-technical-spec-v0.2.md 4.3: cadence is server config) avoids
// coupling two independent concepts to the same timer.
const REPORT_CLIP_BOUND = 0.1; // 10% per-step return
const REPORT_EPSILON = 0.5; // epsilon spent per release's performance stats
const REPORT_EPSILON_CAP = 50_000_000n; // 50.0 cumulative epsilon, generous for a demo session
// Demo-only: a real deployment never hardcodes this, and it would not help if
// it did -- the secret only shapes which noise lands, never whether a release
// is accepted. See reporter/noise.mjs.
const REPORT_SECRET = "mandate-demo-reporter-secret";

export async function startChain() {
  const compiled = compileContracts();
  // EDR stamps every block at least one second after the previous one. The demo
  // mines several blocks a second (a mine, a mark, one observe per vault), so
  // without this override chain time would run several times faster than the
  // clock and every "seconds" term on screen would mean something else.
  const chain = await hre.network.create({ override: { allowBlocksWithSameTimestamp: true } });
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 50;

  const owner = await provider.getSigner(0);
  const allocator = await provider.getSigner(1);
  const keeper = await provider.getSigner(9);
  const agents = await Promise.all([2, 3, 4, 5].map((i) => provider.getSigner(i)));

  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const contract = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const abiOf = (source, name) => artifact(compiled, `contracts/src/${source}.sol`, name).abi;

  let deployment = null;
  let venue = null;
  let guard = null;
  let batchAllocator = null;
  let batchDomain = null;
  let batchGenesis = 0;
  // In-memory "batcher mempool": signed AllocationIntents that have not been
  // netted into a settleEpoch() call yet, keyed only by holding the full signed
  // struct (BatchAllocator itself never sees these until settlement).
  let pendingIntents = [];
  // intent digest -> { intent, proof }, filled in once settleEpoch() lands so a
  // claim can be relayed without a chain indexer (batch-allocator-milestone2.md
  // notes proofs can be rebuilt from public calldata; this is that rebuild).
  let claimableProofs = new Map();

  let registry = null;
  let dpReporter = null;
  // "epoch" for DP releases is just a strictly-increasing release counter, not
  // a wall-clock window -- see the REPORT_* constants above.
  let nextReportEpoch = 0;
  let lastRelease = null;
  // Per-vault step returns pooled since the last release, and a market-wide
  // (average-across-vaults) NAV series for the drawdown stat. Reset on publish.
  let pooledReturns = [];
  let marketNavSeries = [];
  let lastNavByVault = new Map();

  async function setup() {
    deployment = await deployDemoSystem({
      deploy, abiOf, provider, owner, allocator, agents, keeper, basePriceE18
    });
    venue = new Contract(deployment.addresses.venue, deployment.abis.venue, owner);
    guard = new Contract(deployment.addresses.guard, deployment.abis.guard, keeper);

    const chainId = deployment.chainId;

    // The batcher is `owner`, same as deploy.mjs does for Monad: settleEpoch()
    // only nets already-verified signed intents, so there is nothing a batcher
    // key can steal by also being the deployer.
    batchAllocator = await deploy("BatchAllocator", "BatchAllocator", [
      deployment.addresses.usdc,
      await owner.getAddress(),
      BATCH_EPOCH_SECONDS,
      BATCH_SETTLEMENT_WINDOW_SECONDS
    ]);
    for (const v of deployment.vaults) {
      await (await batchAllocator.setVaultAllowed(v.address, true)).wait();
    }
    const batchAddress = await batchAllocator.getAddress();
    batchGenesis = Number(await batchAllocator.genesis());
    batchDomain = intentDomain(chainId, batchAddress);
    pendingIntents = [];
    claimableProofs = new Map();

    // MandateRegistry: `owner` is both the admin and the configured reporter,
    // same centralization-is-the-point tradeoff as the batcher above. `owner`
    // is also `guard`'s Ownable owner (it deployed `guard` via deployDemoSystem),
    // which is exactly who registerAgent() now requires as the caller. Each
    // vault registers itself right after lockTerms() -- registerAgent() reads
    // the real guard off the vault itself and checks the claimed limits
    // against its termsHash, so this can only ever publish the truth, never
    // something looser than what allocators actually signed up for.
    registry = await deploy("MandateRegistry", "MandateRegistry");
    await (await registry.setReporter(await owner.getAddress())).wait();
    await (await registry.setEpsilonCap(REPORT_EPSILON_CAP)).wait();
    for (const v of deployment.vaults) {
      // v.limits is already the exact merged-and-locked RiskLimits (serialised
      // for JSON transport, but keccak256(abi.encode(...)) only depends on the
      // numeric value, not whether a given field arrived as a bigint or a
      // decimal string) -- registerAgent() hashes it and checks the result
      // against guard.termsHash(vault) itself, so there is nothing to recompute.
      await (
        await registry.registerAgent(
          v.address,
          deployment.addresses.adapter,
          v.limits,
          { performanceFeeBps: 0, managementFeeBps: 0 },
          ZeroHash
        )
      ).wait();
    }
    const registryAddress = await registry.getAddress();

    dpReporter = new DPReporter({
      reporterSecret: REPORT_SECRET,
      signer: owner,
      registryAddress,
      chainId,
      cap: REPORT_EPSILON_CAP,
      clipBound: REPORT_CLIP_BOUND,
      epsilon: REPORT_EPSILON,
      statsVersion: 1
    });
    nextReportEpoch = 0;
    lastRelease = null;
    pooledReturns = [];
    marketNavSeries = [];
    lastNavByVault = new Map();

    deployment = {
      ...deployment,
      abis: { ...deployment.abis, batch: abiOf("BatchAllocator", "BatchAllocator"), registry: abiOf("MandateRegistry", "MandateRegistry") },
      batch: {
        address: batchAddress,
        genesis: batchGenesis,
        epochDuration: BATCH_EPOCH_SECONDS,
        settlementWindow: BATCH_SETTLEMENT_WINDOW_SECONDS
      },
      registry: {
        address: registryAddress,
        clipBound: REPORT_CLIP_BOUND,
        epsilon: REPORT_EPSILON
      }
    };
    return deployment;
  }

  function batchEpochEnd(epoch) {
    return batchGenesis + (epoch + 1) * BATCH_EPOCH_SECONDS;
  }
  function batchDeadline(epoch) {
    return batchEpochEnd(epoch) + BATCH_SETTLEMENT_WINDOW_SECONDS;
  }

  // --- price oracle -------------------------------------------------------
  //
  // `updatedAt` only moves when setPrice lands, so how often a mark can be
  // refreshed is bounded by how often a block can carry it. That bound is the
  // block time, and it is the one thing the UI's block-time switch changes.
  let basePriceE18 = START_PRICE;
  let blockTimeSeconds = 1;
  let pendingShockBps = 0;
  let lastPushTs = 0;
  let ticks = 0;
  let busy = false;

  const chainNow = async () => {
    const block = await chain.provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false]
    });
    return Number(block.timestamp);
  };

  async function beat() {
    if (busy || !deployment) return;
    busy = true;
    try {
      await chain.provider.request({ method: "evm_mine", params: [] });
      const now = await chainNow();
      if (now - lastPushTs < blockTimeSeconds) return;

      ticks += 1;
      if (pendingShockBps !== 0) {
        basePriceE18 = (basePriceE18 * BigInt(10_000 + pendingShockBps)) / 10_000n;
        pendingShockBps = 0;
      }
      // A small deterministic wobble so the tape is alive without ever being
      // large enough to trip a mandate on its own.
      const wobbleBps = Math.round(8 * Math.sin(ticks / 9));
      const priceE18 = (basePriceE18 * BigInt(10_000 + wobbleBps)) / 10_000n;
      await (await venue.setPrice(priceE18)).wait();
      lastPushTs = await chainNow();
      // Feed the mark to every vault with a volatility clause. observe() only
      // updates the estimate - it never freezes, never pays a bounty - so it can
      // run on every push without stealing the poke() step from the demo.
      for (const vault of deployment.vaults) {
        if (Number(vault.limits.volWindowSeconds) === 0) continue;
        try {
          await (await guard.observe(vault.address, deployment.addresses.adapter)).wait();
        } catch (error) {
          console.error("[observe]", vault.key, error.shortMessage || error.message);
        }
      }

      // Pool a step return per vault (for the Reporter's mean/Sharpe sample)
      // and the average NAV across vaults this tick (for the market-wide
      // drawdown stat). Public data only: every input here is a `quote()` read
      // anyone could make, same as the Market screen's own numbers.
      const navsThisTick = [];
      for (const vault of deployment.vaults) {
        try {
          const [navPerShare] = await guard.quote(vault.address, deployment.addresses.adapter);
          const nav = Number(formatUnits(navPerShare, 18));
          navsThisTick.push(nav);
          const previous = lastNavByVault.get(vault.address);
          if (previous !== undefined && previous !== 0) {
            pooledReturns.push(nav / previous - 1);
            if (pooledReturns.length > 2000) pooledReturns.shift();
          }
          lastNavByVault.set(vault.address, nav);
        } catch (error) {
          console.error("[reporter:quote]", vault.key, error.shortMessage || error.message);
        }
      }
      if (navsThisTick.length > 0) {
        marketNavSeries.push(navsThisTick.reduce((a, b) => a + b, 0) / navsThisTick.length);
        if (marketNavSeries.length > 2000) marketNavSeries.shift();
      }
    } catch (error) {
      console.error("[oracle]", error.shortMessage || error.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(beat, 400);

  const control = {
    async status() {
      return {
        live: false,
        blockTimeSeconds,
        priceE18: (await venue.priceE18()).toString(),
        markedAt: Number(await venue.updatedAt()),
        chainTime: await chainNow(),
        basePrice: formatUnits(basePriceE18, 18)
      };
    },
    setBlockTime(seconds) {
      const value = Number(seconds);
      if (![1, 12].includes(value)) throw new Error("blockTime must be 1 or 12");
      blockTimeSeconds = value;
      return { blockTimeSeconds };
    },
    shock(bps) {
      const value = Math.trunc(Number(bps));
      if (!Number.isFinite(value) || Math.abs(value) > 3000) throw new Error("shock out of range");
      pendingShockBps = value;
      return { pendingShockBps };
    },
    restorePrice() {
      basePriceE18 = START_PRICE;
      pendingShockBps = 0;
      return { basePrice: formatUnits(basePriceE18, 18) };
    },
    async redeploy() {
      basePriceE18 = START_PRICE;
      pendingShockBps = 0;
      lastPushTs = 0;
      await setup();
      return { ok: true, startedAt: deployment.startedAt };
    }
  };

  // --- batch allocator epoch flow -----------------------------------------
  //
  // This plays the off-chain "batcher" role the spec and
  // docs/batch-allocator-milestone2.md assume: collect signed
  // AllocationIntents, net them per vault once an epoch ends, and settle with
  // a Merkle root the contract recomputes and checks itself. In production
  // this is a separate service with its own key; here the demo server plays
  // that role with the same `owner` account that deploys everything, exactly
  // like deploy.mjs does for Monad.
  const batch = {
    async status() {
      const now = await chainNow();
      const currentEpoch = Math.max(0, Math.floor((now - batchGenesis) / BATCH_EPOCH_SECONDS));
      return {
        chainTime: now,
        genesis: batchGenesis,
        epochDuration: BATCH_EPOCH_SECONDS,
        settlementWindow: BATCH_SETTLEMENT_WINDOW_SECONDS,
        currentEpoch,
        currentEpochEnd: batchEpochEnd(currentEpoch),
        pending: pendingIntents.map(({ intent, digest }) => ({ ...intent, digest }))
      };
    },

    // Minimal validation here; settleEpoch() re-verifies every signature,
    // nonce, epoch, deadline and escrow balance itself and is the only check
    // that actually matters. This just keeps an obviously-bad intent (wrong
    // signer, unknown vault) out of a batch that would otherwise revert whole.
    async submitIntent({ intent, signature } = {}) {
      if (!intent || !signature) throw new Error("missing intent or signature");
      for (const key of ["allocator", "vault", "amount", "minShares", "epoch", "nonce", "deadline"]) {
        if (intent[key] === undefined || intent[key] === null) throw new Error(`intent missing ${key}`);
      }
      const recovered = verifyTypedData(batchDomain, intentTypes, intent, signature);
      if (recovered.toLowerCase() !== String(intent.allocator).toLowerCase()) {
        throw new Error("signature does not match intent.allocator");
      }
      const vaultKnown = deployment.vaults.some(
        (v) => v.address.toLowerCase() === String(intent.vault).toLowerCase()
      );
      if (!vaultKnown) throw new Error("vault is not part of this demo");
      const digest = hashIntent(batchDomain, intent);
      if (pendingIntents.some((p) => p.digest === digest)) {
        return { accepted: true, digest, duplicate: true };
      }
      pendingIntents.push({ intent, signature, digest });
      return { accepted: true, digest };
    },

    // Settles whichever pending epoch is currently inside its settlement
    // window. One net deposit per vault, exactly as settleEpoch() requires.
    async settle() {
      const now = await chainNow();
      const candidates = [...new Set(pendingIntents.map((p) => Number(p.intent.epoch)))].sort(
        (a, b) => a - b
      );
      const epoch = candidates.find((e) => now >= batchEpochEnd(e) && now <= batchDeadline(e));
      if (epoch === undefined) {
        const next = candidates[0];
        if (next === undefined) throw new Error("no pending intents to settle");
        const wait = Math.max(0, batchEpochEnd(next) - now);
        throw new Error(
          wait > 0
            ? `epoch ${next} is not settleable yet — ${wait}s left before it ends`
            : `epoch ${next} is past its settlement window`
        );
      }

      const forEpoch = pendingIntents.filter((p) => Number(p.intent.epoch) === epoch);
      const byVault = new Map();
      for (const entry of forEpoch) {
        const key = getAddress(entry.intent.vault);
        if (!byVault.has(key)) byVault.set(key, []);
        byVault.get(key).push(entry);
      }
      const sortedVaults = [...byVault.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const nets = sortedVaults.map((v) => ({ vault: v, intents: byVault.get(v) }));
      const flatIntents = nets.flatMap((net) => net.intents.map((e) => e.intent));
      const { root, proofs } = buildIntentTree(batchDomain, flatIntents);
      const netsForTx = nets.map((net) => ({
        vault: net.vault,
        intents: net.intents.map((e) => ({ intent: e.intent, signature: e.signature }))
      }));

      const receipt = await (
        await batchAllocator.connect(owner).settleEpoch(epoch, root, netsForTx)
      ).wait();

      flatIntents.forEach((intent, i) => {
        claimableProofs.set(hashIntent(batchDomain, intent), { intent, proof: proofs[i] });
      });
      pendingIntents = pendingIntents.filter((p) => Number(p.intent.epoch) !== epoch);

      return {
        epoch,
        intentCount: flatIntents.length,
        vaultCount: nets.length,
        txHash: receipt.hash
      };
    },

    // Reconstructed from the settlement this server itself just ran, which is
    // the "future API/UI integration" batch-allocator-milestone2.md leaves
    // open rather than an indexer reading public calldata from scratch.
    //
    // claimShares() leaves the proof's digest in this map after a successful
    // claim -- the map only records what settlement produced, not what is
    // still outstanding -- so a second relay of the same claim would revert
    // InvalidClaim(). Drop anything the contract no longer shows a nonzero
    // entitlement for, and prune it so this stays cheap as epochs go by.
    async claimsFor(address) {
      const needle = String(address || "").toLowerCase();
      const mine = [];
      for (const [digest, { intent, proof }] of claimableProofs) {
        if (String(intent.allocator).toLowerCase() !== needle) continue;
        const shares = await batchAllocator.claimableShares(digest);
        if (shares === 0n) {
          claimableProofs.delete(digest);
          continue;
        }
        mine.push({ intent, proof });
      }
      return mine;
    }
  };

  // --- DP reporter ----------------------------------------------------------
  //
  // Plays the Reporter role from mandate-technical-spec-v0.2.md 4: pools
  // public per-vault step returns and the market-wide NAV series beat() has
  // been collecting, builds a signed release (reporter/reporter.mjs), and
  // posts it to MandateRegistry. Scoped to public data only (2026-10-04
  // decision) -- there is no private watchlist or pre-settlement-intent
  // aggregate here, because this demo has no such feature to protect.
  const reporterApi = {
    async status() {
      const [cumulativeEpsilonE6, epsilonCap, lastEpoch, hasReleased] = await Promise.all([
        registry.cumulativeEpsilonE6(),
        registry.epsilonCap(),
        registry.lastEpoch(),
        registry.hasReleased()
      ]);
      return {
        address: await registry.getAddress(),
        cumulativeEpsilonE6: cumulativeEpsilonE6.toString(),
        epsilonCap: epsilonCap.toString(),
        lastEpoch: lastEpoch.toString(),
        hasReleased,
        nextEpoch: nextReportEpoch,
        sampleSize: pooledReturns.length,
        clipBound: REPORT_CLIP_BOUND,
        epsilon: REPORT_EPSILON,
        lastRelease
      };
    },

    // Anyone can trigger this in the demo; only the transaction's effect is
    // gated, by postLeaderboard()'s check that the EIP-712 signature recovers
    // to the one configured reporter (`owner`, held by this server) -- the
    // same relay-friendly shape as BatchAllocator.claimShares().
    async publish() {
      if (pooledReturns.length < 3) {
        throw new Error(
          `need at least 3 sampled returns to release, have ${pooledReturns.length} -- wait for a few more price ticks`
        );
      }
      const pinnedBlock = await provider.getBlockNumber();
      const { release, signature, published } = await dpReporter.buildRelease({
        epoch: nextReportEpoch,
        pinnedBlock,
        perTradeReturns: pooledReturns,
        navSeries: marketNavSeries.length >= 2 ? marketNavSeries : [1, 1]
      });

      const receipt = await (
        await registry
          .connect(owner)
          .postLeaderboard(
            release.epoch,
            release.pinnedBlock,
            release.statsDigest,
            release.epsilonPerfE6,
            release.epsilonIntentE6,
            release.cumulativeEpsilonE6,
            signature
          )
      ).wait();
      dpReporter.commit(release.epoch, release.cumulativeEpsilonE6);

      lastRelease = {
        epoch: Number(release.epoch),
        pinnedBlock: Number(release.pinnedBlock),
        statsDigest: release.statsDigest,
        epsilonPerfE6: release.epsilonPerfE6.toString(),
        cumulativeEpsilonE6: release.cumulativeEpsilonE6.toString(),
        txHash: receipt.hash,
        published
      };
      nextReportEpoch += 1;
      pooledReturns = [];
      // Keep the last point so the next window still has a drawdown baseline
      // instead of starting from an empty series.
      marketNavSeries = marketNavSeries.slice(-1);

      return lastRelease;
    }
  };

  await setup();

  return {
    provider: chain.provider,
    deployment: () => deployment,
    control,
    batch,
    reporter: reporterApi,
    touch() {},
    async close() {
      clearInterval(timer);
      await chain.close();
    }
  };
}

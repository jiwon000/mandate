// Boots an in-process EDR chain, deploys the real Mandate contracts onto it, and
// keeps a price oracle stamping marks at a configurable block cadence.
//
// This is the demo's chain. Nothing here is mocked at the UI layer: the browser
// talks to these contracts over JSON-RPC and every number it renders is read back
// from contract state.
import hre from "hardhat";
import { AbiCoder, BrowserProvider, ContractFactory, parseUnits, formatUnits, getAddress, verifyTypedData } from "ethers";
import { artifact, compileContracts } from "../contracts/tools/compiler.mjs";
import { buildIntentTree, hashIntent, intentDomain, intentTypes } from "../contracts/tools/batch.mjs";

const coder = AbiCoder.defaultAbiCoder();
const E18 = (n) => parseUnits(String(n), 18);
const USDC = (n) => parseUnits(String(n), 6);

const START_PRICE = E18(2000);

// Short enough that a live demo sees an epoch end and settle inside one
// session; the privileged settleEpoch() call still only nets signed intents,
// it never picks who gets how many shares (BatchAllocator.sol _allocate()).
const BATCH_EPOCH_SECONDS = 20;
const BATCH_SETTLEMENT_WINDOW_SECONDS = 600;

// Four vaults, one venue, one adapter. They differ only in the mandate their
// allocators signed - that is the entire point of the screen.
const MANDATES = [
  {
    key: "steady",
    name: "Steady Basis",
    initials: "SB",
    thesis: "Low-leverage basis carry",
    deposit: USDC(12_000),
    openSizeE18: E18(3),
    limits: {
      maxLeverageX100: 150, maxDrawdownBps: 800, maxMarkAgeSeconds: 60,
      volWindowSeconds: 300, stressHorizonSeconds: 300, stressSigmasX10: 30
    }
  },
  {
    key: "range",
    name: "Range Carry",
    initials: "RC",
    thesis: "Mean-reversion inside a band",
    deposit: USDC(8_000),
    openSizeE18: E18(6),
    limits: {
      maxLeverageX100: 300, maxDrawdownBps: 1200, maxMarkAgeSeconds: 30,
      volWindowSeconds: 120, stressHorizonSeconds: 120, stressSigmasX10: 30
    }
  },
  {
    key: "momentum",
    name: "Momentum Vector",
    initials: "MV",
    thesis: "Levered trend following",
    deposit: USDC(5_000),
    openSizeE18: E18(10),
    limits: {
      maxLeverageX100: 500, maxDrawdownBps: 2000, maxMarkAgeSeconds: 30,
      volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 20
    }
  },
  {
    key: "tight",
    name: "Tight Mandate",
    initials: "TM",
    thesis: "3% drawdown, 4s mark age",
    deposit: USDC(6_000),
    openSizeE18: E18(6),
    limits: {
      maxLeverageX100: 300, maxDrawdownBps: 300, maxMarkAgeSeconds: 4,
      volWindowSeconds: 60, stressHorizonSeconds: 60, stressSigmasX10: 30
    }
  }
];
// The last three terms are the volatility clause (roadmap item 10): a realised
// volatility estimate over `volWindowSeconds` of marks, and any order that adds
// exposure must survive a `stressSigmasX10/10`-sigma move over
// `stressHorizonSeconds` without breaching maxDrawdownBps. Zero window = no clause.

// Generous notional caps across the board so leverage and drawdown are what
// actually bind. A cap that never binds teaches nobody anything.
const NOTIONAL_LIMITS = {
  minBlocksBetweenTrades: 0,
  maxOrderNotional: E18(25_000),
  maxPositionNotional: E18(40_000),
  maxTotalNotional: E18(40_000),
  maxBlockNotional: E18(25_000)
};

// JSON has no BigInt, and the notional caps are 1e18-scaled. Ship them as decimal
// strings so the browser can BigInt() them back without losing precision.
function serialiseLimits(limits) {
  return Object.fromEntries(
    Object.entries(limits).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])
  );
}

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
  const agents = await Promise.all(MANDATES.map((_, i) => provider.getSigner(2 + i)));

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
  let adapterAddress = null;
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

  async function setup() {
    // The vaults' own allocation and opening trades are the first entries the
    // execution feed shows, so the browser needs to know where to start reading.
    const startBlock = await provider.getBlockNumber();
    const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
    guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
    venue = await deploy("mocks/DeterministicMockVenue", "DeterministicMockVenue", [basePriceE18]);
    const adapter = await deploy("MockVenueAdapter", "MockVenueAdapter", [await venue.getAddress()]);
    adapterAddress = await adapter.getAddress();
    await (await venue.setAdapter(adapterAddress, true)).wait();

    const allocatorAddress = await allocator.getAddress();
    const totalDeposits = MANDATES.reduce((sum, m) => sum + m.deposit, 0n);
    await (await usdc.mint(allocatorAddress, totalDeposits + USDC(20_000))).wait();

    const vaults = [];
    for (const [index, mandate] of MANDATES.entries()) {
      const agentAddress = await agents[index].getAddress();
      const vault = await deploy("MandateVault", "MandateVault", [
        await usdc.getAddress(),
        await guard.getAddress(),
        agentAddress,
        await adapter.getAddress()
      ]);
      const vaultAddress = await vault.getAddress();

      await (await guard.setAdapter(vaultAddress, await adapter.getAddress(), true)).wait();
      await (await guard.configure(vaultAddress, { ...NOTIONAL_LIMITS, ...mandate.limits })).wait();
      // Terms are final before the first deposit; the vault would refuse it otherwise.
      await (await guard.lockTerms(vaultAddress)).wait();

      // Seed the vault, then let its agent open the position its mandate allows.
      await (await usdc.connect(allocator).approve(vaultAddress, mandate.deposit)).wait();
      await (await vault.connect(allocator).allocate(mandate.deposit, allocatorAddress)).wait();
      // Deploying and configuring burns blocks, and every block burns chain time.
      // Re-stamp the mark first or a tight maxMarkAgeSeconds rejects the opening
      // trade - which is the guard working, just not what we want at seed time.
      await (await venue.setPrice(basePriceE18)).wait();
      const order = coder.encode(["int256", "uint256"], [mandate.openSizeE18, basePriceE18 * 2n]);
      await (await vault.connect(agents[index]).execute(await adapter.getAddress(), order)).wait();

      vaults.push({
        ...mandate,
        address: vaultAddress,
        agent: agentAddress,
        termsHash: await guard.termsHash(vaultAddress),
        deposit: mandate.deposit.toString(),
        openSizeE18: mandate.openSizeE18.toString(),
        limits: serialiseLimits({ ...NOTIONAL_LIMITS, ...mandate.limits })
      });
    }

    const chainId = Number((await provider.getNetwork()).chainId);

    // The batcher is `owner`, same as deploy.mjs does for Monad: settleEpoch()
    // only nets already-verified signed intents, so there is nothing a batcher
    // key can steal by also being the deployer.
    batchAllocator = await deploy("BatchAllocator", "BatchAllocator", [
      await usdc.getAddress(),
      await owner.getAddress(),
      BATCH_EPOCH_SECONDS,
      BATCH_SETTLEMENT_WINDOW_SECONDS
    ]);
    for (const v of vaults) {
      await (await batchAllocator.setVaultAllowed(v.address, true)).wait();
    }
    const batchAddress = await batchAllocator.getAddress();
    batchGenesis = Number(await batchAllocator.genesis());
    batchDomain = intentDomain(chainId, batchAddress);
    pendingIntents = [];
    claimableProofs = new Map();

    deployment = {
      chainId,
      addresses: {
        usdc: await usdc.getAddress(),
        guard: await guard.getAddress(),
        venue: await venue.getAddress(),
        adapter: await adapter.getAddress()
      },
      accounts: {
        owner: await owner.getAddress(),
        allocator: allocatorAddress,
        keeper: await keeper.getAddress()
      },
      abis: {
        vault: abiOf("MandateVault", "MandateVault"),
        guard: abiOf("MandateRiskGuard", "MandateRiskGuard"),
        adapter: abiOf("MockVenueAdapter", "MockVenueAdapter"),
        venue: abiOf("mocks/DeterministicMockVenue", "DeterministicMockVenue"),
        usdc: abiOf("mocks/MockUSDC", "MockUSDC"),
        batch: abiOf("BatchAllocator", "BatchAllocator")
      },
      batch: {
        address: batchAddress,
        genesis: batchGenesis,
        epochDuration: BATCH_EPOCH_SECONDS,
        settlementWindow: BATCH_SETTLEMENT_WINDOW_SECONDS
      },
      vaults,
      startBlock,
      startedAt: Date.now()
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
          await (await guard.connect(keeper).observe(vault.address, adapterAddress)).wait();
        } catch (error) {
          console.error("[observe]", vault.key, error.shortMessage || error.message);
        }
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

  await setup();

  return {
    provider: chain.provider,
    deployment: () => deployment,
    control,
    batch,
    async close() {
      clearInterval(timer);
      await chain.close();
    }
  };
}

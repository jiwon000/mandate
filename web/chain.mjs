// Boots an in-process EDR chain, deploys the real Mandate contracts onto it, and
// keeps a price oracle stamping marks at a configurable block cadence.
//
// This is the demo's chain. Nothing here is mocked at the UI layer: the browser
// talks to these contracts over JSON-RPC and every number it renders is read back
// from contract state.
import hre from "hardhat";
import { AbiCoder, BrowserProvider, ContractFactory, parseUnits, formatUnits } from "ethers";
import { artifact, compileContracts } from "../contracts/tools/compiler.mjs";

const coder = AbiCoder.defaultAbiCoder();
const E18 = (n) => parseUnits(String(n), 18);
const USDC = (n) => parseUnits(String(n), 6);

const START_PRICE = E18(2000);

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
    limits: { maxLeverageX100: 150, maxDrawdownBps: 800, maxMarkAgeSeconds: 60 }
  },
  {
    key: "range",
    name: "Range Carry",
    initials: "RC",
    thesis: "Mean-reversion inside a band",
    deposit: USDC(8_000),
    openSizeE18: E18(6),
    limits: { maxLeverageX100: 300, maxDrawdownBps: 1200, maxMarkAgeSeconds: 30 }
  },
  {
    key: "momentum",
    name: "Momentum Vector",
    initials: "MV",
    thesis: "Levered trend following",
    deposit: USDC(5_000),
    openSizeE18: E18(10),
    limits: { maxLeverageX100: 500, maxDrawdownBps: 2000, maxMarkAgeSeconds: 30 }
  },
  {
    key: "tight",
    name: "Tight Mandate",
    initials: "TM",
    thesis: "3% drawdown, 4s mark age",
    deposit: USDC(6_000),
    openSizeE18: E18(6),
    limits: { maxLeverageX100: 300, maxDrawdownBps: 300, maxMarkAgeSeconds: 4 }
  }
];

// Generous notional caps across the board so leverage and drawdown are what
// actually bind. A cap that never binds teaches nobody anything.
const NOTIONAL_LIMITS = {
  maxSlippageBps: 100,
  minBlocksBetweenTrades: 0,
  maxConsecutiveRejects: 3,
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
  const chain = await hre.network.create();
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

  async function setup() {
    // The vaults' own allocation and opening trades are the first entries the
    // execution feed shows, so the browser needs to know where to start reading.
    const startBlock = await provider.getBlockNumber();
    const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
    const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
    venue = await deploy("mocks/DeterministicMockVenue", "DeterministicMockVenue", [basePriceE18]);
    const adapter = await deploy("MockVenueAdapter", "MockVenueAdapter", [await venue.getAddress()]);
    await (await venue.setAdapter(await adapter.getAddress(), true)).wait();

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
        deposit: mandate.deposit.toString(),
        openSizeE18: mandate.openSizeE18.toString(),
        limits: serialiseLimits({ ...NOTIONAL_LIMITS, ...mandate.limits })
      });
    }

    deployment = {
      chainId: Number((await provider.getNetwork()).chainId),
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
        usdc: abiOf("mocks/MockUSDC", "MockUSDC")
      },
      vaults,
      startBlock,
      startedAt: Date.now()
    };
    return deployment;
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

  await setup();

  return {
    provider: chain.provider,
    deployment: () => deployment,
    control,
    async close() {
      clearInterval(timer);
      await chain.close();
    }
  };
}

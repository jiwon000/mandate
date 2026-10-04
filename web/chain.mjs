// Boots an in-process EDR chain, deploys the real Mandate contracts onto it, and
// keeps a price oracle stamping marks at a configurable block cadence.
//
// This is the demo's chain. Nothing here is mocked at the UI layer: the browser
// talks to these contracts over JSON-RPC and every number it renders is read back
// from contract state. The mandates themselves, and the routine that deploys and
// seeds them, live in ./mandates.mjs and are shared with the live-RPC deploy.
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, formatUnits } from "ethers";
import { artifact, compileContracts } from "../contracts/tools/compiler.mjs";
import { START_PRICE, deployDemoSystem } from "./mandates.mjs";

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

  async function setup() {
    deployment = await deployDemoSystem({
      deploy, abiOf, provider, owner, allocator, agents, keeper, basePriceE18
    });
    venue = new Contract(deployment.addresses.venue, deployment.abis.venue, owner);
    guard = new Contract(deployment.addresses.guard, deployment.abis.guard, keeper);
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

  await setup();

  return {
    provider: chain.provider,
    deployment: () => deployment,
    control,
    touch() {},
    async close() {
      clearInterval(timer);
      await chain.close();
    }
  };
}

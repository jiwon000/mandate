import assert from "node:assert/strict";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, parseUnits } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder } from "./fixture.mjs";

// A vault on PerplAdapter against MockPerplExchange, with no network: margin really
// leaves the vault for the venue, which the deterministic mock venue never does.

export const compiled = compileContracts();
export const e18 = (x) => parseUnits(String(x), 18);
export const usd = (x) => parseUnits(String(x), 6);
export const BTC = 16;
export const ETH = 32;
export const BTC_PNS = 600_000n; // $60,000.0, priceDecimals 1, lotDecimals 5
export const ETH_PNS = 300_000n; // $3,000.00, priceDecimals 2, lotDecimals 4

/// `floor` is the unwind bounty floor to set before the lock, in mUSDC units; 0 leaves it off.
export async function setup(t, { deposit = usd(1_000), trade = {}, floor = 0n } = {}) {
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, allocator, agent, keeper] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const rpc = (method, params = []) => chain.provider.request({ method, params });
  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const c = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const wait = async (p) => (await p).wait();

  const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
  const exchange = await deploy("mocks/MockPerplExchange", "MockPerplExchange", [usdc.target]);
  await wait(exchange.listPerp(BTC, 1, 5, BTC_PNS));
  await wait(exchange.listPerp(ETH, 2, 4, ETH_PNS));
  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  const adapter = await deploy("perpl/PerplAdapter", "PerplAdapter", [exchange.target, usdc.target, 500, 300, [BTC, ETH]]);
  const vault = await deploy("MandateVault", "MandateVault", [usdc.target, guard.target, agent.address, adapter.target]);
  await wait(guard.setAdapter(vault.target, adapter.target, true));
  await wait(guard.configureTerms(vault.target, BASE_LIMITS,
    { ...DEFAULT_TRADE, allowedMarkets: 3, ...trade }, NO_FEES));
  if (floor) await wait(guard.setUnwindBountyFloor(vault.target, floor));
  await wait(guard.lockTerms(vault.target));
  await wait(usdc.mint(allocator.address, deposit));
  await wait(usdc.connect(allocator).approve(vault.target, deposit));
  await wait(vault.connect(allocator).allocate(deposit, allocator.address));

  /// Re-stamp both marks at the latest block, as Perpl does when its price moves.
  async function fresh(btc = BTC_PNS, eth = ETH_PNS) {
    const { timestamp } = await provider.getBlock("latest");
    await wait(exchange.setMark(BTC, btc, timestamp));
    await wait(exchange.setMark(ETH, eth, timestamp));
  }
  const order = (marketId, size, limit) =>
    coder.encode(["uint256", "int256", "uint256"], [marketId, e18(size), e18(limit)]);
  const trade_ = async (marketId, size, limit) => {
    await fresh();
    return wait(vault.connect(agent).execute(adapter.target, order(marketId, size, limit)));
  };
  const lots = async (perpId) => {
    const id = await adapter.accountIdOf(vault.target);
    const [p] = await exchange.getPositionV2(perpId, id);
    return p.lotLNS;
  };
  /// Freeze through the holding-time term, as a keeper would.
  async function freeze() {
    await rpc("evm_increaseTime", [10]);
    await rpc("evm_mine");
    await fresh();
    await wait(guard.connect(keeper).poke(vault.target, adapter.target));
    assert.equal(await vault.state(), 1n);
  }
  async function unwindStep() {
    await fresh();
    await wait(vault.connect(keeper).unwind());
    return vault.state();
  }
  return { provider, rpc, owner, allocator, agent, keeper, usdc, exchange, guard, adapter, vault,
    fresh, order, trade: trade_, lots, freeze, unwindStep, wait };
}

import assert from "node:assert/strict";
import test from "node:test";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, parseUnits } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder } from "./fixture.mjs";

// PerplAdapter against MockPerplExchange, with no network. The fork test proves the
// adapter against Perpl's real exchange; this one reaches what a fork cannot choose:
// a market that refuses orders, closes that fill in part, a withdrawal Perpl holds
// back, a vault under Perpl's account minimum.

const compiled = compileContracts();
const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);
const BTC = 16;
const ETH = 32;
const BTC_PNS = 600_000n; // $60,000.0, priceDecimals 1, lotDecimals 5
const ETH_PNS = 300_000n; // $3,000.00, priceDecimals 2, lotDecimals 4

async function setup(t, { deposit = usd(1_000), trade = {} } = {}) {
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
  const adapter = await deploy("perpl/PerplAdapter", "PerplAdapter", [exchange.target, usdc.target, 500, [BTC, ETH]]);
  const vault = await deploy("MandateVault", "MandateVault", [usdc.target, guard.target, agent.address, adapter.target]);
  await wait(guard.setAdapter(vault.target, adapter.target, true));
  await wait(guard.configureTerms(vault.target, BASE_LIMITS,
    { ...DEFAULT_TRADE, allowedMarkets: 3, ...trade }, NO_FEES));
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

test("an open moves only its margin to Perpl and equity counts both sides", async (t) => {
  const s = await setup(t);
  await s.trade(0, "0.005", "60600"); // $300 of BTC at 5x venue leverage
  assert.equal(await s.lots(BTC), 500n);
  const cash = await s.usdc.balanceOf(s.vault.target);
  // About $300 / 5 + 2% sits at Perpl; nothing else leaves the vault.
  assert.ok(cash < usd(1_000) - usd(60) && cash > usd(1_000) - usd(70), `cash ${cash}`);
  const [equity] = await s.adapter.markEquity(s.vault.target);
  // Only the taker fee is gone: 0.035% of $300.
  assert.equal(equity, usd(1_000) - 105_000n);
  // A 1% mark move on the long moves equity by $3.
  await s.fresh(BTC_PNS * 101n / 100n, ETH_PNS);
  const [after] = await s.adapter.markEquity(s.vault.target);
  assert.equal(after - equity, usd(3));
});

test("a fill above the agent's limit is killed whole, with no money moved", async (t) => {
  const s = await setup(t);
  await s.wait(s.exchange.setFill(BTC, BTC_PNS * 102n / 100n, 0));
  await s.fresh();
  await assert.rejects(s.vault.connect(s.agent).execute(s.adapter.target, s.order(0, "0.005", "60600")));
  assert.equal(await s.usdc.balanceOf(s.vault.target), usd(1_000));
  assert.equal(await s.adapter.accountIdOf(s.vault.target), 0n);
});

test("a vault under Perpl's account minimum is refused before any transfer", async (t) => {
  const s = await setup(t, { deposit: usd(50) });
  await s.fresh();
  await assert.rejects(
    s.vault.connect(s.agent).execute(s.adapter.target, s.order(0, "0.0003", "60600")),
    (error) => String(error?.message).includes(s.adapter.interface.getError("BelowAccountMinimum").selector) ||
      error?.revert?.name === "BelowAccountMinimum"
  );
  assert.equal(await s.usdc.balanceOf(s.vault.target), usd(50));
});

test("unwind closes what it can when one market refuses, and finishes once it reopens", async (t) => {
  const s = await setup(t, { trade: { maxHoldingSeconds: 5 } });
  await s.trade(0, "0.005", "60600");
  await s.trade(1, "-0.1", "2970"); // $300 ETH short
  await s.freeze();
  await s.wait(s.exchange.setPaused(ETH, true));
  for (let i = 0; i < 6; i++) assert.equal(await s.unwindStep(), 1n);
  // BTC is flat; the paused ETH short is untouched and the vault stays Frozen.
  assert.equal(await s.lots(BTC), 0n);
  assert.equal(await s.lots(ETH), 1_000n);
  await s.wait(s.exchange.setPaused(ETH, false));
  assert.equal(await s.unwindStep(), 2n);
  assert.equal(await s.lots(ETH), 0n);
  // Everything is back in the vault, less Perpl's four taker fees (0.42) and the
  // freeze and unwind bounties paid to the keeper.
  const sub = await s.adapter.subaccountOf(s.vault.target);
  assert.equal((await s.exchange.getAccountByAddr(sub)).balanceCNS, 0n);
  const cash = await s.usdc.balanceOf(s.vault.target);
  const bounties = await s.usdc.balanceOf(s.keeper.address);
  assert.equal(cash + bounties, usd(1_000) - 420_000n);
});

test("closes that fill in part keep unwinding until the position is gone", async (t) => {
  const s = await setup(t, { trade: { maxHoldingSeconds: 5 } });
  await s.trade(0, "0.005", "60600");
  await s.freeze();
  await s.wait(s.exchange.setFill(BTC, 0, 60)); // at most 60 lots per order
  let state = 1n;
  let steps = 0;
  while (state === 1n && steps < 12) { state = await s.unwindStep(); steps++; }
  assert.equal(state, 2n);
  assert.ok(steps > 5, `took ${steps} steps`);
  assert.equal(await s.lots(BTC), 0n);
});

test("a stale mark is skipped like a refusal rather than reverting the step", async (t) => {
  const s = await setup(t, { trade: { maxHoldingSeconds: 5 } });
  await s.trade(0, "0.005", "60600");
  await s.trade(1, "0.1", "3030");
  await s.freeze();
  // ETH's mark stops updating; Perpl refuses orders on it past 60s.
  await s.rpc("evm_increaseTime", [120]);
  await s.rpc("evm_mine");
  const { timestamp } = await s.provider.getBlock("latest");
  await s.wait(s.exchange.setMark(BTC, BTC_PNS, timestamp));
  await s.wait(s.vault.connect(s.keeper).unwind());
  assert.ok((await s.lots(BTC)) < 500n);
  assert.equal(await s.lots(ETH), 1_000n);
});

test("a withdrawal Perpl holds back stays in equity and sweep returns it later", async (t) => {
  const s = await setup(t);
  await s.trade(0, "0.005", "60600");
  await s.wait(s.exchange.setWithdrawBlocked(true));
  // Selling half frees margin at Perpl, which cannot leave yet.
  await s.trade(0, "-0.0025", "59400");
  const sub = await s.adapter.subaccountOf(s.vault.target);
  const held = (await s.exchange.getAccountByAddr(sub)).balanceCNS;
  assert.ok(held > 0n);
  const [equity] = await s.adapter.markEquity(s.vault.target);
  assert.ok(equity > usd(999), `equity ${equity}`);
  await s.wait(s.exchange.setWithdrawBlocked(false));
  const before = await s.usdc.balanceOf(s.vault.target);
  await s.wait(s.adapter.connect(s.keeper).sweep(s.vault.target));
  assert.equal((await s.usdc.balanceOf(s.vault.target)) - before, held);
  const [same] = await s.adapter.markEquity(s.vault.target);
  assert.equal(same, equity);
});

test("funding Perpl books against a position moves equity and settles on close", async (t) => {
  const s = await setup(t);
  await s.trade(0, "0.005", "60600");
  const [before] = await s.adapter.markEquity(s.vault.target);
  const id = await s.adapter.accountIdOf(s.vault.target);
  await s.wait(s.exchange.setPremium(BTC, id, -usd(5)));
  await s.fresh();
  const [paid] = await s.adapter.markEquity(s.vault.target);
  assert.equal(before - paid, usd(5));
  // Closing the whole long realises it: the cash that comes back is short by the same 5.
  await s.trade(0, "-0.005", "59400");
  const cash = await s.usdc.balanceOf(s.vault.target);
  assert.equal(cash, paid - 105_000n);
});

test("a close reports its price PnL at Perpl's mark in Executed", async (t) => {
  const s = await setup(t);
  await s.trade(0, "0.005", "60600");
  // Up 1%: selling 0.003 of the 0.005 long realises 0.003 * $600.
  await s.fresh(BTC_PNS * 101n / 100n, ETH_PNS);
  const receipt = await s.wait(s.vault.connect(s.agent).execute(s.adapter.target, s.order(0, "-0.003", "59400")));
  const executed = receipt.logs.map((log) => { try { return s.vault.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "Executed");
  assert.equal(executed.args.realizedPnl, e18("1.8"));
});

test("the factory refuses a Perpl adapter that settles in another token", async (t) => {
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const owner = await provider.getSigner(0);
  const deploy = async (source, name, args = []) => {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const c = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
  const other = await deploy("mocks/MockUSDC", "MockUSDC");
  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  const registry = await deploy("MandateRegistry", "MandateRegistry");
  const factory = await deploy("MandateFactory", "MandateFactory", [usdc.target, guard.target, registry.target]);
  const exchange = await deploy("mocks/MockPerplExchange", "MockPerplExchange", [other.target]);
  const wrong = await deploy("perpl/PerplAdapter", "PerplAdapter", [exchange.target, other.target, 500, [BTC]]);
  const right = await deploy("perpl/PerplAdapter", "PerplAdapter", [exchange.target, usdc.target, 500, [BTC]]);
  await assert.rejects(factory.listAdapter(wrong.target, true),
    (error) => String(error?.message).includes(factory.interface.getError("AdapterAssetMismatch").selector) ||
      error?.revert?.name === "AdapterAssetMismatch");
  await (await factory.listAdapter(right.target, true)).wait();
  assert.equal(await factory.adapterListed(right.target), true);
  // Delisting never needs the check.
  await (await factory.listAdapter(wrong.target, false)).wait();
});

test("a venue that cannot be read at all can still be frozen and exited for cash", async (t) => {
  const s = await setup(t);
  await s.trade(0, "0.005", "60600");
  await s.wait(s.exchange.setBroken(true));
  await assert.rejects(s.adapter.markEquity(s.vault.target));
  // No mark at all counts as the oldest mark there is.
  await s.wait(s.guard.connect(s.keeper).freezeUnobservable(s.vault.target));
  assert.equal(await s.vault.state(), 1n);

  const shares = (await s.vault.balanceOf(s.allocator.address)) / 2n;
  const supply = await s.vault.totalSupply();
  const cash = await s.usdc.balanceOf(s.vault.target);
  const [,, lastNav] = await s.guard.dayOf(s.vault.target);
  const bySlice = (shares * cash) / supply;
  const byMark = (shares * lastNav) / 10n ** 18n;
  const expected = bySlice < byMark ? bySlice : byMark;
  const before = await s.usdc.balanceOf(s.allocator.address);
  await s.wait(s.vault.connect(s.allocator).withdrawUnpriced(shares, s.allocator.address, expected));
  assert.equal((await s.usdc.balanceOf(s.allocator.address)) - before, expected);
  // Those who stay keep at least the cash per share they had.
  const cashAfter = await s.usdc.balanceOf(s.vault.target);
  assert.ok(cashAfter * supply >= cash * (supply - shares));
});

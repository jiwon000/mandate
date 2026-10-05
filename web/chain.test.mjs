// The local demo book end to end: what a visitor with their own wallet can do
// on it, and the trade terms each demo mandate locked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, BrowserProvider, Contract, Wallet, ZeroHash, parseEther } from "ethers";
import { startChain } from "./chain.mjs";
import { FAUCET_USDC } from "./faucet.mjs";
import { E18, USDC, limitPriceFor } from "./mandates.mjs";

const coder = AbiCoder.defaultAbiCoder();
const marketOrder = (market, size, limit) => coder.encode(["uint256", "int256", "uint256"], [market, size, limit]);

test("a visitor funds a wallet, opens a mandate through the factory, and each term binds", { timeout: 300_000 }, async () => {
  const chain = await startChain();
  try {
    const d = chain.deployment();
    const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 50;
    const visitor = Wallet.createRandom().connect(provider);
    const at = (name, runner = visitor) => new Contract(d.addresses[name], d.abis[name], runner);

    // Faucet: once per address.
    await chain.faucet.drip({ address: visitor.address, ip: "203.0.113.7" });
    assert.equal(await at("usdc").balanceOf(visitor.address), FAUCET_USDC);
    assert.ok((await provider.getBalance(visitor.address)) >= parseEther("1"));
    await assert.rejects(chain.faucet.drip({ address: visitor.address, ip: "203.0.113.8" }), /already received/);

    // Permissionless registration: the visitor is operator and agent.
    const factory = at("factory");
    const guard = at("guard");
    const params = {
      agent: visitor.address,
      adapter: d.addresses.adapter,
      limits: {
        maxOrderNotional: E18(5_000), maxPositionNotional: E18(8_000), maxTotalNotional: E18(8_000), maxBlockNotional: E18(5_000),
        maxLeverageX100: 200, minBlocksBetweenTrades: 0, maxDrawdownBps: 1000, maxMarkAgeSeconds: 30,
        volWindowSeconds: 0, stressHorizonSeconds: 0, stressSigmasX10: 0
      },
      trade: { allowedMarkets: 0b10, direction: 1, maxPriceDeviationBps: 100, maxTradesPerDay: 2, maxDailyLossBps: 500, maxHoldingSeconds: 0 },
      fees: { performanceFeeBps: 1000, managementFeeBps: 100 },
      modelHash: ZeroHash
    };
    const receipt = await (await factory.createMandate(params)).wait();
    const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "MandateCreated");
    const vaultAddress = created.args.vault;
    assert.equal(await factory.vaultCount(), 1n);
    assert.equal(created.args.termsHash, await guard.termsHash(vaultAddress));

    const registry = new Contract(d.registry.address, d.abis.registry, provider);
    assert.deepEqual([...(await registry.vaultsOf(visitor.address))], [vaultAddress]);

    const vault = new Contract(vaultAddress, d.abis.vault, visitor);
    await (await at("usdc").approve(vaultAddress, USDC(4_000))).wait();
    await (await vault.allocate(USDC(4_000), visitor.address)).wait();

    const venue = at("venue", provider);
    const btc = await venue.priceOf(1);
    const long = (E18(1) * 8n) / 100n; // 0.08 BTC, about 4,800 notional at 60k: 1.2x on 4,000
    // The guard's errors bubble up through the vault, so they decode on the guard's ABI.
    const fails = (order, error) =>
      assert.rejects(vault.execute.staticCall(d.addresses.adapter, order), (e) => {
        const name = guard.interface.parseError(e?.data ?? "0x")?.name ?? "";
        return new RegExp(`^(${error})$`).test(name);
      });

    await fails(marketOrder(0, long, limitPriceFor(await venue.priceOf(0), long, 100)), "MarketNotAllowed");
    await fails(marketOrder(1, -long, limitPriceFor(btc, -long, 100)), "DirectionNotAllowed");
    await fails(marketOrder(1, long, (btc * 103n) / 100n), "PriceDeviationExceeded");
    await fails(marketOrder(1, long * 2n, limitPriceFor(btc, long * 2n, 100)), "LeverageExceeded|OrderNotionalExceeded");

    await (await vault.execute(d.addresses.adapter, marketOrder(1, long, limitPriceFor(btc, long, 100)))).wait();
    const tiny = E18(1) / 1000n;
    await (await vault.execute(d.addresses.adapter, marketOrder(1, tiny, limitPriceFor(await venue.priceOf(1), tiny, 100)))).wait();
    await fails(marketOrder(1, tiny, limitPriceFor(await venue.priceOf(1), tiny, 100)), "DailyTradesExceeded");
  } finally {
    await chain.close();
  }
});

test("the demo book locks the trade terms and fees each mandate states", { timeout: 300_000 }, async () => {
  const chain = await startChain();
  try {
    const d = chain.deployment();
    const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
    const guard = new Contract(d.addresses.guard, d.abis.guard, provider);
    assert.deepEqual(d.markets.map((m) => m.symbol), ["ETH", "BTC"]);
    for (const v of d.vaults) {
      const trade = await guard.tradeTermsOf(v.address);
      const fees = await guard.feesOf(v.address);
      assert.equal(Number(trade.allowedMarkets), v.trade.allowedMarkets, v.key);
      assert.equal(Number(trade.direction), v.trade.direction, v.key);
      assert.equal(Number(trade.maxPriceDeviationBps), v.trade.maxPriceDeviationBps, v.key);
      assert.equal(Number(fees.performanceFeeBps), v.fees.performanceFeeBps, v.key);
      assert.equal(Number(fees.managementFeeBps), v.fees.managementFeeBps, v.key);
      assert.equal(await guard.termsHash(v.address), v.termsHash, v.key);
    }
  } finally {
    await chain.close();
  }
});

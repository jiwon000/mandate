import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "ethers";
import { fixture } from "./fixture.mjs";
import { downsample, getLogsChunked, summarize, trackRecord } from "../tools/track-record.mjs";

const e18 = (n) => parseUnits(String(n), 18);
const mark = (block, nav, hwm, dd, time = 1000 + block) => ({
  name: "Marked", blockNumber: block, logIndex: 0, txHash: `0xm${block}`, time,
  args: { navPerShare: e18(nav), highWaterNavPerShare: e18(hwm), drawdownBps: BigInt(dd) }
});

test("summarize: returns, drawdown against the limit, money and breaches from plain events", () => {
  const events = [
    { name: "Allocated", blockNumber: 1, logIndex: 0, txHash: "0xa", time: 1001, args: { assets: 1_000_000_000n, shares: 1n } },
    mark(2, 1, 1, 0),
    { name: "Executed", blockNumber: 2, logIndex: 1, txHash: "0xe1", time: 1002, args: { realizedPnl: 0n } },
    { name: "Executed", blockNumber: 3, logIndex: 0, txHash: "0xe2", time: 1003, args: { realizedPnl: 0n } },
    mark(4, 1.1, 1.1, 0),
    mark(5, 0.99, 1.1, 1000),
    { name: "FeesAccrued", blockNumber: 5, logIndex: 1, txHash: "0xf", time: 1005, args: { managementAssets: 2_000_000n, performanceAssets: 3_000_000n } },
    { name: "DrawdownBreach", blockNumber: 5, logIndex: 2, txHash: "0xb", time: 1005, args: { drawdownBps: 1000n } },
    { name: "Withdrawn", blockNumber: 6, logIndex: 0, txHash: "0xw", time: 1006, args: { assets: 400_000_000n } }
  ].reverse();

  const s = summarize(events, { limits: { maxDrawdownBps: 800 }, state: 1, freeze: { reason: 1, frozenAt: 1005 }, decimals: 6 });
  assert.equal(s.marks, 3);
  assert.equal(s.firstMarkTime, 1002);
  assert.equal(s.lastMarkTime, 1005);
  assert.equal(s.navPerShareFirst, 1);
  assert.equal(s.navPerShareLast, 0.99);
  assert.equal(s.returnPct, -1);
  assert.equal(s.maxDrawdownBps, 1000);
  assert.equal(s.drawdownLimitBps, 800);
  assert.equal(s.limitUsedPct, 125);
  assert.equal(s.trades, 2);
  assert.equal(s.deposits, "1000.0");
  assert.equal(s.withdrawals, "400.0");
  assert.deepEqual(s.fees, { management: "2.0", performance: "3.0" });
  assert.deepEqual(s.breaches.map((b) => [b.type, b.txHash, b.drawdownBps]), [["drawdown", "0xb", 1000]]);
  assert.equal(s.state, "Frozen");
  assert.equal(s.freezeReason, "drawdown");
  assert.deepEqual(s.navSeries.map((p) => p.nav), [1, 1.1, 0.99]);
});

test("summarize: an empty history is all zeros and nulls, not a crash", () => {
  const s = summarize([], { limits: { maxDrawdownBps: 300 }, state: 0 });
  assert.equal(s.marks, 0);
  assert.equal(s.returnPct, null);
  assert.equal(s.maxDrawdownBps, 0);
  assert.equal(s.trades, 0);
  assert.equal(s.state, "Active");
  assert.deepEqual(s.breaches, []);
});

test("summarize: a daily-loss pause and a resume are recorded beside the freezes", () => {
  const events = [
    mark(1, 1, 1, 0),
    { name: "DailyLossPause", blockNumber: 2, logIndex: 0, txHash: "0xp", time: 1002, args: { lossBps: 600n } },
    { name: "Unobservable", blockNumber: 3, logIndex: 0, txHash: "0xu", time: 1003, args: {} },
    { name: "Resumed", blockNumber: 4, logIndex: 0, txHash: "0xr", time: 1004, args: {} }
  ];
  const s = summarize(events, { state: 0, freeze: { reason: 2, frozenAt: 1003 } });
  assert.deepEqual(s.breaches.map((b) => [b.type, b.lossBps]), [["dailyLossPause", 600], ["unobservable", undefined]]);
  assert.equal(s.resumes, 1);
  assert.equal(s.state, "Active");
  assert.equal(s.freezeReason, "unobservable", "the last freeze, kept after the resume");
});

test("downsample keeps first and last and never exceeds the cap", () => {
  const points = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(points, 200);
  assert.equal(out.length, 200);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 999);
  assert.deepEqual(downsample([1, 2, 3], 200), [1, 2, 3]);
});

test("getLogsChunked windows the range and retries a refused window once as halves", async () => {
  const calls = [];
  const provider = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > 5) throw new Error("block range too large");
      return [{ from: fromBlock, to: toBlock }];
    }
  };
  const logs = await getLogsChunked(provider, {}, 0, 19, 10);
  // Two windows of 10, each refused, each answered as two halves of 5.
  assert.equal(logs.length, 4);
  assert.deepEqual(logs.map((l) => [l.from, l.to]), [[0, 4], [5, 9], [10, 14], [15, 19]]);
  assert.equal(calls.length, 6);

  await assert.rejects(getLogsChunked({ getLogs: async () => { throw new Error("nope"); } }, {}, 0, 3, 4), /nope/);
});

test("trackRecord rebuilds a vault's history from chain events, breach included", async (t) => {
  const f = await fixture(t);
  const guardAddress = await f.guard.getAddress();
  const start = (await f.provider.getBlockNumber()) - 20;

  // One trade, a within-limit dip and recovery, then a drop past the 2% limit and a poke.
  await (await f.vault.connect(f.agent).execute(f.adapterAddress, f.order)).wait();
  await (await f.venue.setPrice(parseUnits("1980", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  await (await f.venue.setPrice(parseUnits("2000", 18))).wait();
  await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();
  await (await f.venue.setPrice(parseUnits("1800", 18))).wait();
  const pokeTx = await (await f.guard.connect(f.keeper).poke(f.vaultAddress, f.adapterAddress)).wait();

  const r = await trackRecord(f.provider, {
    guard: guardAddress, vault: f.vaultAddress, fromBlock: Math.max(start, 0), chunk: 7
  });

  assert.equal(r.trades, 1);
  assert.equal(r.deposits, "1000.0");
  assert.equal(r.withdrawals, "0.0");
  assert.equal(r.maxDrawdownBps, 1000, "10% against the high-water mark");
  assert.equal(r.drawdownLimitBps, 200);
  assert.equal(r.state, "Frozen");
  assert.equal(r.freezeReason, "drawdown");
  assert.ok(r.marks >= 4);
  assert.equal(r.navPerShareFirst, 1);
  assert.ok(r.navPerShareLast < 1);
  assert.equal(r.breaches.length, 1);
  assert.equal(r.breaches[0].type, "drawdown");
  assert.equal(r.breaches[0].drawdownBps, 1000);
  assert.equal(r.breaches[0].txHash, pokeTx.hash);
  assert.ok(r.navSeries.length <= 200);
  assert.ok(r.firstMarkTime <= r.lastMarkTime);
});

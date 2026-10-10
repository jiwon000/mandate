import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { AGENT_LOG_URL, createPerplReader, readPerpl, summarizeAgentLog } from "./perpl.mjs";

const deployment = {
  chainId: "10143",
  vault: "0x00000000000000000000000000000000000000v1",
  PerplAdapter: "0x00000000000000000000000000000000000000a1",
  MandateRiskGuard: "0x00000000000000000000000000000000000000g1",
  MandateRegistry: "0x00000000000000000000000000000000000000r1",
  MandateFactory: "0x00000000000000000000000000000000000000f1",
  perpl: { exchange: "0x00000000000000000000000000000000000000e1" },
  termsHash: "0xabc"
};

// Stub contracts keyed by address; no provider, no network.
function stubs(calls = { n: 0 }) {
  const byAddress = {
    [deployment.PerplAdapter]: {
      positionState: async () => [10n ** 17n, 10n ** 17n],
      markEquity: async () => [149_900_000n, 1_791_289_561n],
      marketPrice: async (id) => (id === 0 ? [86_138_7n * 10n ** 17n, 1_791_289_560n] : assert.fail("BTC only")),
      venueLeverageHdths: async () => 200n,
      maxAdverseLimitBps: async () => 300n
    },
    [deployment.vault]: { state: async () => 0n, totalAssets: async () => 149_900_000n, totalSupply: async () => 150_000_000n },
    [deployment.MandateRiskGuard]: {
      termsLocked: async () => true,
      limitsOf: async () => ({ maxPositionNotional: 200n * 10n ** 18n, maxTotalNotional: 200n * 10n ** 18n, maxDrawdownBps: 200n, maxMarkAgeSeconds: 60n })
    }
  };
  return (address) => {
    calls.n += 1;
    return byAddress[address];
  };
}

test("readPerpl stringifies chain reads into a JSON-safe summary", async () => {
  const out = await readPerpl({ deployment, contract: stubs(), agentLog: () => "" });
  assert.equal(out.vault.status, "Active");
  assert.equal(out.vault.totalAssets, "149900000");
  assert.equal(out.position.positionNotional, (10n ** 17n).toString());
  assert.deepEqual(out.equity, { value: "149900000", markedAt: 1_791_289_561 });
  assert.equal(out.mark.markedAt, 1_791_289_560);
  assert.equal(out.terms.maxDrawdownBps, 200);
  assert.equal(out.terms.maxMarkAgeSeconds, 60);
  assert.equal(out.terms.maxPositionNotional, (200n * 10n ** 18n).toString());
  assert.equal(out.addresses.adapter, deployment.PerplAdapter);
  assert.equal(out.activity.ticks, 0);
  JSON.stringify(out); // no bigint left
});

test("the reader caches for the ttl, then reads again", async () => {
  let clock = 0;
  const calls = { n: 0 };
  const read = createPerplReader({ deployment, provider: {}, contract: stubs(calls), ttlMs: 30_000, now: () => clock });
  const first = await read();
  const reads = calls.n;
  assert.equal(await read(), first);
  assert.equal(calls.n, reads);
  clock = 30_001;
  assert.notEqual(await read(), first);
  assert.ok(calls.n > reads);
});

test("a failed read is not cached", async () => {
  let fail = true;
  const good = stubs();
  const contract = (address) => {
    const c = good(address);
    return fail && address === deployment.vault ? { ...c, state: async () => Promise.reject(new Error("rpc down")) } : c;
  };
  const read = createPerplReader({ deployment, provider: {}, contract });
  await assert.rejects(read(), /rpc down/);
  fail = false;
  assert.equal((await read()).vault.status, "Active");
});

test("the agent log is summarized into totals and the latest transactions", () => {
  const tx = (n) => `0x${String(n).repeat(64)}`;
  const log = [
    { run: 1, time: "2026-10-06T12:48:00Z", kind: "allocate", allocateTx: tx(9) },
    { run: 1, time: "2026-10-06T12:49:00Z", kind: "tick", action: "buy", orderBtc: 0.001, tx: tx(1), status: 1 },
    { run: 1, time: "2026-10-06T12:50:00Z", kind: "tick", action: "hold", breach: { notionalUsd: 260, error: "PositionNotionalExceeded()", tx: tx(2), status: 0 } },
    { run: 2, time: "2026-10-07T09:00:00Z", kind: "tick", action: "sell", orderBtc: -0.002, tx: tx(3), status: 0 },
    { run: 2, time: "2026-10-07T09:05:00Z", kind: "exit", tx: tx(4), status: 1 }
  ].map((e) => JSON.stringify(e)).join("\n") + "\n{\"torn";
  const a = summarizeAgentLog(log);
  assert.deepEqual([a.runs, a.ticks, a.fills, a.refusals], [2, 3, 2, 1]);
  assert.equal(a.firstAt, "2026-10-06T12:48:00Z");
  assert.deepEqual(a.recent.map((t) => t.hash), [tx(4), tx(2), tx(1)]);
  assert.match(a.recent[1].label, /\$260 position, PositionNotionalExceeded/);
});

test("the committed agent log parses and every transaction hash is well formed", () => {
  const a = summarizeAgentLog(readFileSync(AGENT_LOG_URL, "utf8"));
  assert.ok(a.fills > 0 && a.refusals > 0);
  assert.ok(a.recent.every((t) => /^0x[0-9a-f]{64}$/.test(t.hash)));
});

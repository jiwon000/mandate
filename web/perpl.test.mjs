import assert from "node:assert/strict";
import { test } from "node:test";
import { createPerplReader, readPerpl } from "./perpl.mjs";

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
  const out = await readPerpl({ deployment, contract: stubs() });
  assert.equal(out.vault.status, "Active");
  assert.equal(out.vault.totalAssets, "149900000");
  assert.equal(out.position.positionNotional, (10n ** 17n).toString());
  assert.deepEqual(out.equity, { value: "149900000", markedAt: 1_791_289_561 });
  assert.equal(out.mark.markedAt, 1_791_289_560);
  assert.equal(out.terms.maxDrawdownBps, 200);
  assert.equal(out.terms.maxMarkAgeSeconds, 60);
  assert.equal(out.terms.maxPositionNotional, (200n * 10n ** 18n).toString());
  assert.equal(out.addresses.adapter, deployment.PerplAdapter);
  assert.ok(out.txs.length >= 2 && out.txs.every((t) => /^0x[0-9a-f]{64}$/.test(t.hash)));
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

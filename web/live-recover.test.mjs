import { test } from "node:test";
import assert from "node:assert/strict";
import { startChain } from "./chain.mjs";
import { bookLayout, latestBook, patient } from "./live-recover.mjs";

test("bookLayout matches the owner's nonces in the first testnet books", () => {
  // Observed on Monad testnet: a book created from nonce 314 through 345.
  assert.deepEqual(bookLayout(314, 4), {
    usdc: 314, guard: 315, venue: 316, adapter: 317, vaults: [320, 325, 330, 335], batch: 340, registry: 345
  });
});

test("patient retries a refusal for rate and passes a revert straight through", async () => {
  let calls = 0;
  const limited = patient(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("missing revert data"), { info: { error: { message: "requests limited to 15/sec" } } });
    return "0x1";
  }, { perSecond: 1000, waitMs: 1 });
  assert.equal(await limited({}), "0x1");
  assert.equal(calls, 3);
  const reverting = patient(async () => { throw new Error("execution reverted"); }, { perSecond: 1000, waitMs: 1 });
  await assert.rejects(reverting({}), /execution reverted/);
});

test("latestBook finds the book a redeploy left behind a stale record", { timeout: 300_000 }, async () => {
  const chain = await startChain();
  try {
    const request = (args) => chain.provider.request(args);
    const stale = structuredClone(chain.deployment());
    // Before a redeploy the newest book on chain is the one the record names.
    const first = await latestBook({ request, record: stale, perSecond: 1000 });
    assert.equal(first.addresses.usdc, stale.addresses.usdc);

    await chain.control.redeploy();
    const fresh = chain.deployment();
    const found = await latestBook({ request, record: stale, perSecond: 1000 });
    assert.ok(found);
    assert.equal(found.addresses.usdc, fresh.addresses.usdc);
    assert.deepEqual(found.addresses, fresh.addresses);
    assert.equal(found.batch.address, fresh.batch.address);
    assert.equal(found.batch.genesis, fresh.batch.genesis);
    assert.equal(found.registry.address, fresh.registry.address);
    assert.deepEqual(found.vaults.map((v) => [v.address, v.agent, v.termsHash]), fresh.vaults.map((v) => [v.address, v.agent, v.termsHash]));
    assert.deepEqual(found.vaults.map((v) => v.limits), fresh.vaults.map((v) => v.limits));
    assert.equal(found.startBlock, fresh.startBlock);
  } finally {
    await chain.close();
  }
});

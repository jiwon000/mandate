import test from "node:test";
import assert from "node:assert/strict";
import { ReadCache, toRpcError } from "./rpc.mjs";

const call = (id, method, params = []) => ({ jsonrpc: "2.0", id, method, params });
const answer = (id, result) => ({ jsonrpc: "2.0", id, result });

test("identical reads within the TTL are served from the cache with the caller's id", () => {
  let now = 1_000;
  const cache = new ReadCache(2_000, () => now);
  const first = call(1, "eth_call", [{ to: "0xabc", data: "0x01" }, "latest"]);
  assert.equal(cache.get(first), null);
  cache.put(first, answer(1, "0xff"));
  const hit = cache.get(call(7, "eth_call", [{ to: "0xabc", data: "0x01" }, "latest"]));
  assert.deepEqual(hit, answer(7, "0xff"));
  now += 2_001;
  assert.equal(cache.get(first), null);
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 2);
});

test("receipts, estimates and transaction lookups are never cached", () => {
  const cache = new ReadCache(2_000);
  for (const method of ["eth_getTransactionReceipt", "eth_estimateGas", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_sendTransaction"]) {
    const c = call(1, method, ["0x1"]);
    cache.put(c, answer(1, { ok: true }));
    assert.equal(cache.get(c), null, method);
  }
  assert.equal(cache.entries.size, 0);
});

test("errors are not cached and a TTL of zero disables the cache", () => {
  const cache = new ReadCache(2_000);
  const c = call(1, "eth_call", [{ to: "0xabc" }, "latest"]);
  cache.put(c, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } });
  assert.equal(cache.get(c), null);
  const off = new ReadCache(0);
  off.put(c, answer(1, "0x01"));
  assert.equal(off.get(c), null);
});

test("clear() drops everything the next state change made stale", () => {
  const cache = new ReadCache(2_000);
  cache.put(call(1, "eth_blockNumber"), answer(1, "0x10"));
  cache.put(call(2, "eth_getLogs", [{ fromBlock: "0x1" }]), answer(2, []));
  assert.equal(cache.entries.size, 2);
  cache.clear();
  assert.equal(cache.get(call(3, "eth_blockNumber")), null);
});

test("toRpcError keeps revert data wherever ethers put it", () => {
  assert.deepEqual(toRpcError({ code: -32000, shortMessage: "execution reverted", info: { error: { data: "0x13e9ce5c" } } }),
    { code: -32000, message: "execution reverted", data: "0x13e9ce5c" });
  assert.deepEqual(toRpcError(new Error("boom")), { code: -32603, message: "boom" });
});

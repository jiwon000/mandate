import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  MULTICALL3, ReadCache, isRateLimited, packCalls, packable, sendPatiently, toRpcError, unpackAnswers
} from "./rpc.mjs";

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

const limited = (id) => ({ jsonrpc: "2.0", id, error: { code: -32011, message: "requests limited to 15/sec" } });

test("calls refused for rate are sent again, the others are not", async () => {
  const calls = [call(1, "eth_call"), call(2, "eth_call"), call(3, "eth_blockNumber")];
  const batches = [];
  const waits = [];
  const answers = await sendPatiently(
    calls,
    async (batch) => {
      batches.push(batch.map((c) => c.id));
      // The first round refuses call 2; the second answers it.
      return batch.map((c) => (c.id === 2 && batches.length === 1 ? limited(2) : answer(c.id, `0x${c.id}`))).reverse();
    },
    { delaysMs: [10, 20], wait: async (ms) => waits.push(ms) }
  );
  assert.deepEqual(batches, [[1, 2, 3], [2]]);
  assert.deepEqual(waits, [10]);
  assert.deepEqual(answers.map((a) => a.result), ["0x1", "0x2", "0x3"]);
});

test("nothing to send means nothing is sent", async () => {
  let rounds = 0;
  assert.deepEqual(await sendPatiently([], async () => { rounds += 1; return []; }), []);
  assert.equal(rounds, 0);
});

test("a call still refused after the last pause comes back as the refusal", async () => {
  let rounds = 0;
  const answers = await sendPatiently(
    [call(7, "eth_call")],
    async () => {
      rounds += 1;
      return [limited(7)];
    },
    { delaysMs: [1, 1], wait: async () => {} }
  );
  assert.equal(rounds, 3);
  assert.equal(isRateLimited(answers[0]), true);
  assert.equal(isRateLimited(answer(1, "0x")), false);
  assert.equal(isRateLimited({ id: 1, error: { code: 3, message: "execution reverted" } }), false);
});

test("only reads that are the same for every caller are bundled", () => {
  const to = "0x0309A8c6C9D416251D2786042857DAba9AE64388";
  assert.equal(packable(call(1, "eth_call", [{ to, data: "0xc19d93fb" }, "latest"])), true);
  assert.equal(packable(call(1, "eth_call", [{ to, input: "0xc19d93fb" }])), true);
  assert.equal(packable(call(1, "eth_call", [{ to, data: "0xc19d93fb", from: to }, "latest"])), false);
  assert.equal(packable(call(1, "eth_call", [{ to, data: "0xc19d93fb", value: "0x1" }, "latest"])), false);
  assert.equal(packable(call(1, "eth_call", [{ to, data: "0xc19d93fb" }, "0x10"])), false);
  assert.equal(packable(call(1, "eth_call", [{ to, data: "0xc19d93fb" }, "latest", {}])), false);
  assert.equal(packable(call(1, "eth_getBalance", [to, "latest"])), false);
});

test("a bundle goes out as one Multicall3 call and comes back as one answer per read", () => {
  const to = "0x0309A8c6C9D416251D2786042857DAba9AE64388";
  const calls = [
    call("a", "eth_call", [{ to, data: "0xc19d93fb" }, "latest"]),
    call("b", "eth_call", [{ to, input: "0x01e1d114" }, "latest"])
  ];
  const bundle = packCalls(calls, "pack");
  assert.equal(bundle.method, "eth_call");
  assert.equal(bundle.params[0].to, MULTICALL3);
  assert.equal(bundle.params[1], "latest");

  const multicall3 = new Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"
  ]);
  const [rows] = multicall3.decodeFunctionData("aggregate3", bundle.params[0].data);
  assert.deepEqual(rows.map((row) => [row.target, row.allowFailure, row.callData]), [[to, true, "0xc19d93fb"], [to, true, "0x01e1d114"]]);

  // The second read reverts with a custom error: its data has to reach the page.
  const result = multicall3.encodeFunctionResult("aggregate3", [[[true, `0x${"00".repeat(31)}01`], [false, "0x13e9ce5c"]]]);
  assert.deepEqual(unpackAnswers(calls, answer("pack", result)), [
    { jsonrpc: "2.0", id: "a", result: `0x${"00".repeat(31)}01` },
    { jsonrpc: "2.0", id: "b", error: { code: 3, message: "execution reverted", data: "0x13e9ce5c" } }
  ]);
  assert.equal(unpackAnswers(calls, limited("pack")), null);
  assert.equal(unpackAnswers(calls, answer("pack", "0x")), null);
});

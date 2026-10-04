import { Interface } from "ethers";

// Revert data has to survive the hop or ethers cannot decode the custom error,
// and the whole point of the demo is showing which error the guard raised.
export function toRpcError(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data ?? error?.cause?.data;
  return {
    code: Number.isInteger(error?.code) ? error.code : -32603,
    message: error?.shortMessage ?? error?.message ?? String(error),
    ...(data === undefined ? {} : { data })
  };
}

export const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
export const rpcFailure = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) }
});

// Every visitor's reads leave the server from one IP against one upstream quota
// (the public testnet RPC answers 15 eth_call a second, measured 2026-10-04),
// and the page polls the same thirty-odd reads every refresh. A short cache lets
// a second visitor ride on the first one's answers. State changes the server can see (its own transactions,
// the oracle, a mined receipt passing through) clear it, so the staleness a
// visitor can notice is bounded by the TTL and only between other people's
// transactions.
const CACHEABLE_READS = new Set([
  "eth_call", "eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber", "eth_chainId",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "net_version"
]);
const CACHE_MAX_ENTRIES = 2000;

export class ReadCache {
  constructor(ttlMs, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  key(call) {
    return CACHEABLE_READS.has(call?.method) ? `${call.method}:${JSON.stringify(call.params ?? [])}` : null;
  }
  // The cached answer for `call`, re-stamped with the caller's id, or null.
  get(call) {
    const key = this.ttlMs > 0 ? this.key(call) : null;
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry || this.now() - entry.at > this.ttlMs) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return { ...entry.answer, id: call.id ?? null };
  }
  put(call, answer) {
    const key = this.ttlMs > 0 ? this.key(call) : null;
    if (!key || !answer || answer.error) return; // errors are never cached
    if (this.entries.size >= CACHE_MAX_ENTRIES) this.entries.clear();
    this.entries.set(key, { at: this.now(), answer });
  }
  clear() {
    this.entries.clear();
  }
}

// --- one upstream quota ----------------------------------------------------
// The public RPC refuses calls over its rate with -32011, inside a batch as one
// error per call under an HTTP 200. Nothing was executed, so asking again a
// moment later is safe for reads and sends alike.
export const RATE_LIMIT_RETRY_MS = [300, 600, 1200, 2000];
export const isRateLimited = (answer) =>
  Boolean(answer?.error) &&
  (answer.error.code === -32011 || answer.error.code === 429 ||
    /limited to|rate limit|too many requests/i.test(String(answer.error.message ?? "")));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends `calls` (unique ids) through `sendBatch` and resends the ones refused
// for rate after each pause in `delaysMs`. Answers come back in call order; a
// call the upstream never answered is undefined.
export async function sendPatiently(calls, sendBatch, { delaysMs = RATE_LIMIT_RETRY_MS, wait = pause } = {}) {
  const answers = new Array(calls.length);
  let pending = calls.map((_, slot) => slot);
  if (!pending.length) return answers; // an empty batch is a 400 upstream
  for (let attempt = 0; ; attempt += 1) {
    const replies = await sendBatch(pending.map((slot) => calls[slot]));
    const byId = new Map((replies ?? []).filter(Boolean).map((reply) => [reply.id, reply]));
    const refused = [];
    for (const slot of pending) {
      answers[slot] = byId.get(calls[slot].id);
      if (isRateLimited(answers[slot])) refused.push(slot);
    }
    if (!refused.length || attempt >= delaysMs.length) return answers;
    await wait(delaysMs[attempt]);
    pending = refused;
  }
}

// One page refresh is thirty-odd eth_calls, twice what the public RPC allows
// in a second. Multicall3 turns them into one. Only calls that read the same
// whoever asks are bundled: a target and calldata at the latest block. A call
// with a `from`, a value or an older block goes upstream as it came.
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall3 = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"
]);

export function packable(call) {
  if (call?.method !== "eth_call") return false;
  const [tx, tag, ...more] = call.params ?? [];
  if (more.length || (tag !== undefined && tag !== "latest")) return false;
  if (!tx || typeof tx !== "object" || typeof tx.to !== "string") return false;
  if (tx.data != null && tx.input != null && tx.data !== tx.input) return false;
  return Object.keys(tx).every((key) => tx[key] == null || key === "to" || key === "data" || key === "input");
}

export function packCalls(calls, id) {
  const rows = calls.map((call) => {
    const [tx] = call.params;
    return [tx.to, true, tx.data ?? tx.input ?? "0x"];
  });
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: MULTICALL3, data: multicall3.encodeFunctionData("aggregate3", [rows]) }, "latest"]
  };
}

// The bundle's answer as one answer per call, a revert keeping its data so the
// page still decodes the custom error. Null when the bundle itself failed.
export function unpackAnswers(calls, answer) {
  if (!answer || answer.error || typeof answer.result !== "string") return null;
  let rows;
  try {
    [rows] = multicall3.decodeFunctionResult("aggregate3", answer.result);
  } catch (error) {
    return null;
  }
  if (rows.length !== calls.length) return null;
  return calls.map((call, slot) =>
    rows[slot].success
      ? rpcResult(call.id ?? null, rows[slot].returnData)
      : rpcFailure(call.id ?? null, 3, "execution reverted", rows[slot].returnData)
  );
}

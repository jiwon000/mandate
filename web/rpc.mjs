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
// (the public testnet RPC allows 25 eth_call/s), and the page polls the same
// forty-odd reads every refresh. A short cache lets a second visitor ride on the
// first one's answers. State changes the server can see (its own transactions,
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

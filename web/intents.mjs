// Allocation intents as the demo server handles them, with no I/O: what a
// well-formed intent is, when an epoch can be settled, and how one epoch's
// intents are laid out for BatchAllocator.settleEpoch().
import { getAddress } from "ethers";
import { buildIntentTree, hashIntent, intentTypes } from "../contracts/tools/batch.mjs";

export const INTENT_FIELDS = intentTypes.AllocationIntent.map((field) => field.name);
const UINT_FIELDS = intentTypes.AllocationIntent.filter((field) => field.type === "uint256").map((field) => field.name);
const MAX_UINT256 = (1n << 256n) - 1n;

function uint(value, name) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`intent ${name} is not an integer`);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`intent ${name} is not an integer`);
  }
  if (typeof value === "string" && !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error(`intent ${name} is not an integer`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_UINT256) throw new Error(`intent ${name} is out of range`);
  return parsed;
}

// One spelling for every intent the server keeps: checksummed addresses and
// decimal strings. The hash is the same whichever spelling was signed.
export function normaliseIntent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("missing intent");
  for (const key of INTENT_FIELDS) {
    if (raw[key] === undefined || raw[key] === null) throw new Error(`intent missing ${key}`);
  }
  const intent = {};
  for (const key of ["allocator", "vault"]) {
    try {
      intent[key] = getAddress(String(raw[key]).toLowerCase());
    } catch {
      throw new Error(`intent ${key} is not an address`);
    }
  }
  for (const key of UINT_FIELDS) intent[key] = uint(raw[key], key).toString();
  if (BigInt(intent.amount) === 0n) throw new Error("intent amount must be greater than zero");
  return intent;
}

// `timing` is the batch allocator's { genesis, epochDuration, settlementWindow }, in seconds.
export const epochEnd = (timing, epoch) => timing.genesis + (Number(epoch) + 1) * timing.epochDuration;
export const settlementDeadline = (timing, epoch) => epochEnd(timing, epoch) + timing.settlementWindow;
export const epochAt = (timing, now) => Math.max(0, Math.floor((now - timing.genesis) / timing.epochDuration));
export const settleable = (timing, epoch, now) => now >= epochEnd(timing, epoch) && now <= settlementDeadline(timing, epoch);

// The epochs among `entries` that can be settled at `now`, oldest first.
export function settleableEpochs(timing, entries, now) {
  return [...new Set(entries.map((entry) => Number(entry.intent.epoch)))]
    .filter((epoch) => settleable(timing, epoch, now))
    .sort((a, b) => a - b);
}

// One epoch's entries in settlement order: vaults ascending by address, and
// within a vault the order the intents arrived in. The leaves of the intent
// root follow that same order, so each proof matches its intent's position.
export function planSettlement(domain, entries) {
  if (entries.length === 0) throw new Error("no intents to settle");
  const byVault = new Map();
  for (const entry of entries) {
    const vault = getAddress(entry.intent.vault);
    if (!byVault.has(vault)) byVault.set(vault, []);
    byVault.get(vault).push(entry);
  }
  const vaults = [...byVault.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const ordered = vaults.flatMap((vault) => byVault.get(vault));
  const { root, proofs } = buildIntentTree(domain, ordered.map((entry) => entry.intent));
  return {
    root,
    vaults,
    nets: vaults.map((vault) => ({
      vault,
      intents: byVault.get(vault).map(({ intent, signature }) => ({ intent, signature }))
    })),
    claims: ordered.map((entry, index) => ({
      digest: hashIntent(domain, entry.intent),
      intent: entry.intent,
      proof: proofs[index]
    }))
  };
}

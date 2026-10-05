// What the live demo server will sign on a visitor's behalf.
//
// The browser asks for signatures over /rpc exactly as it does against the
// in-process node, but on a public testnet the signing keys sit on the server
// and anyone with the URL can reach them. So each demo account may only call
// the functions its role needs, on the contracts of this deployment, with no
// value attached. Everything else is refused before a key is touched.
//
// The one off-chain signature the page asks for is an allocation intent for the
// batch allocator. It is signed for the allocator only, over this deployment's
// own domain, so the proxy cannot be used to sign anything else as typed data.
import { Interface } from "ethers";
import { intentTypes } from "../contracts/tools/batch.mjs";
import { normaliseIntent } from "./intents.mjs";

export const ROLE_RULES = {
  allocator: [
    ["usdc", "approve"],
    ["vault", "allocate"],
    ["vault", "withdraw"],
    ["vault", "unwind"],
    ["guard", "poke"],
    ["guard", "observe"]
  ],
  keeper: [
    ["guard", "poke"],
    ["guard", "observe"],
    ["vault", "unwind"]
  ],
  // An agent signs execute() on its own vault and nothing else.
  agent: [["ownVault", "execute"]]
};
// What the allocator may call on the batch allocator, when the deployment has
// one. Approving it on USDC is already covered: approve() is allowed whoever the
// spender is, and an allowance is only spent by a call the allocator signs.
export const BATCH_RULES = ["depositEscrow", "withdrawEscrow", "claimShares"];
export const INTENT_DOMAIN_NAME = "MandateBatchAllocator";
export const INTENT_DOMAIN_VERSION = "1";

export function buildPolicy(deployment) {
  const ifaces = {
    usdc: new Interface(deployment.abis.usdc),
    guard: new Interface(deployment.abis.guard),
    vault: new Interface(deployment.abis.vault)
  };
  const batchAddress = deployment.batch?.address && deployment.abis.batch ? deployment.batch.address : null;
  if (batchAddress) ifaces.batch = new Interface(deployment.abis.batch);
  const selectorOf = (kind, fn) => ifaces[kind === "ownVault" ? "vault" : kind].getFunction(fn).selector.toLowerCase();

  const allow = new Map(); // from -> Map(to -> Map(selector -> name))
  const roles = new Map(); // from -> role
  const grant = (from, role, to, kind, fn) => {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    roles.set(f, role);
    if (!allow.has(f)) allow.set(f, new Map());
    if (!allow.get(f).has(t)) allow.get(f).set(t, new Map());
    allow.get(f).get(t).set(selectorOf(kind, fn), fn);
  };

  const vaultAddresses = deployment.vaults.map((v) => v.address);
  const targetsFor = (kind) => (kind === "vault" ? vaultAddresses : [deployment.addresses[kind]]);
  for (const [kind, fn] of ROLE_RULES.allocator) {
    for (const to of targetsFor(kind)) grant(deployment.accounts.allocator, "allocator", to, kind, fn);
  }
  for (const [kind, fn] of ROLE_RULES.keeper) {
    for (const to of targetsFor(kind)) grant(deployment.accounts.keeper, "keeper", to, kind, fn);
  }
  for (const vault of deployment.vaults) {
    for (const [, fn] of ROLE_RULES.agent) grant(vault.agent, "agent", vault.address, "ownVault", fn);
  }
  if (batchAddress) {
    for (const fn of BATCH_RULES) grant(deployment.accounts.allocator, "allocator", batchAddress, "batch", fn);
  }

  return {
    // Checksummed addresses as the browser's eth_accounts answer.
    accounts: [
      deployment.accounts.allocator,
      ...deployment.vaults.map((v) => v.agent),
      deployment.accounts.keeper
    ],
    allow,
    roles,
    // The typed data the allocator signs, or null on a deployment with no batch allocator.
    intents: batchAddress
      ? {
          signer: deployment.accounts.allocator.toLowerCase(),
          chainId: BigInt(deployment.chainId),
          verifyingContract: batchAddress.toLowerCase(),
          vaults: new Set(vaultAddresses.map((address) => address.toLowerCase()))
        }
      : null
  };
}

const deny = (reason) => ({ ok: false, reason });

// `tx` is the object the browser passes to eth_sendTransaction: hex strings.
export function authorise(policy, tx) {
  if (!tx || typeof tx !== "object") return deny("malformed transaction");
  const from = String(tx.from ?? "").toLowerCase();
  const targets = policy.allow.get(from);
  if (!targets) return deny("unknown account");
  if (tx.value !== undefined && tx.value !== null && BigInt(tx.value) !== 0n) {
    return deny("value transfers are not signed");
  }
  const to = String(tx.to ?? "").toLowerCase();
  const selectors = targets.get(to);
  if (!selectors) return deny("contract is not in this account's allowlist");
  const data = String(tx.data ?? tx.input ?? "");
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return deny("missing calldata");
  const selector = data.slice(0, 10).toLowerCase();
  const name = selectors.get(selector);
  if (!name) return deny(`function ${selector} is not allowed for this account`);
  return { ok: true, role: policy.roles.get(from), name };
}

const sameFields = (a, b) =>
  Array.isArray(a) && a.length === b.length && a.every((field, i) => field?.name === b[i].name && field?.type === b[i].type);

// `address` and `payload` are the two parameters of eth_signTypedData_v4; the
// payload arrives as a JSON string. On success the caller signs `intent` with
// the deployment's own domain and types, never the ones in the request.
export function authoriseTypedData(policy, address, payload) {
  const rules = policy.intents;
  if (!rules) return deny("this deployment has no batch allocator to sign intents for");
  if (String(address ?? "").toLowerCase() !== rules.signer) return deny("only the allocator signs allocation intents");
  let data = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload);
    } catch {
      return deny("malformed typed data");
    }
  }
  if (!data || typeof data !== "object" || !data.domain || typeof data.domain !== "object") return deny("malformed typed data");
  if (data.primaryType !== "AllocationIntent") return deny("only AllocationIntent is signed");
  if (data.types?.AllocationIntent !== undefined && !sameFields(data.types.AllocationIntent, intentTypes.AllocationIntent)) {
    return deny("AllocationIntent does not have the batch allocator's fields");
  }
  const { name, version, chainId, verifyingContract, ...rest } = data.domain;
  let chain;
  try {
    chain = BigInt(chainId);
  } catch {
    return deny("typed data is for another domain");
  }
  if (
    Object.keys(rest).length > 0 || name !== INTENT_DOMAIN_NAME || version !== INTENT_DOMAIN_VERSION ||
    chain !== rules.chainId || String(verifyingContract ?? "").toLowerCase() !== rules.verifyingContract
  ) {
    return deny("typed data is for another domain");
  }
  let intent;
  try {
    intent = normaliseIntent(data.message);
  } catch (error) {
    return deny(error.message);
  }
  if (intent.allocator.toLowerCase() !== rules.signer) return deny("the intent names another allocator");
  if (!rules.vaults.has(intent.vault.toLowerCase())) return deny("the intent names a vault outside this deployment");
  return { ok: true, intent };
}

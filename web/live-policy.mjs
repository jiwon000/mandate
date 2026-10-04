// What the live demo server will sign on a visitor's behalf.
//
// The browser asks for signatures over /rpc exactly as it does against the
// in-process node, but on a public testnet the signing keys sit on the server
// and anyone with the URL can reach them. So each demo account may only call
// the functions its role needs, on the contracts of this deployment, with no
// value attached. Everything else is refused before a key is touched.
import { Interface } from "ethers";

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

export function buildPolicy(deployment) {
  const ifaces = {
    usdc: new Interface(deployment.abis.usdc),
    guard: new Interface(deployment.abis.guard),
    vault: new Interface(deployment.abis.vault)
  };
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

  return {
    // Checksummed addresses as the browser's eth_accounts answer.
    accounts: [
      deployment.accounts.allocator,
      ...deployment.vaults.map((v) => v.agent),
      deployment.accounts.keeper
    ],
    allow,
    roles
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

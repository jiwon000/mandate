import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { authorise, authoriseTypedData, buildPolicy } from "./live-policy.mjs";
import { intentDomain, intentTypes } from "../contracts/tools/batch.mjs";

const abis = {
  usdc: ["function approve(address,uint256) returns (bool)", "function mint(address,uint256)"],
  guard: ["function poke(address,address)", "function observe(address,address)", "function configure(address,uint256)"],
  vault: ["function allocate(uint256,address)", "function withdraw(uint256,address)", "function unwind()", "function execute(address,bytes)"]
};
const A = (n) => `0x${String(n).padStart(40, "0")}`;
const deployment = {
  abis,
  addresses: { usdc: A(10), guard: A(11), venue: A(12), adapter: A(13) },
  accounts: { owner: A(1), allocator: A(2), keeper: A(9) },
  vaults: [
    { address: A(20), agent: A(3) },
    { address: A(21), agent: A(4) }
  ]
};
const iface = Object.fromEntries(Object.entries(abis).map(([k, v]) => [k, new Interface(v)]));
const tx = (from, to, data, extra = {}) => ({ from, to, data, ...extra });
const policy = buildPolicy(deployment);

test("eth_accounts lists allocator, agents and keeper, never the owner", () => {
  assert.deepEqual(policy.accounts, [A(2), A(3), A(4), A(9)]);
});

test("allocator may approve the vault on USDC and allocate, withdraw, unwind and poke", () => {
  const ok = (to, kind, fn, args) => authorise(policy, tx(A(2), to, iface[kind].encodeFunctionData(fn, args)));
  assert.equal(ok(A(10), "usdc", "approve", [A(20), 1n]).ok, true);
  assert.equal(ok(A(20), "vault", "allocate", [1n, A(2)]).ok, true);
  assert.equal(ok(A(21), "vault", "withdraw", [1n, A(2)]).ok, true);
  assert.equal(ok(A(21), "vault", "unwind", []).ok, true);
  assert.equal(ok(A(11), "guard", "poke", [A(20), A(13)]).ok, true);
});

test("allocator may not mint, configure the guard, or touch an unknown contract", () => {
  assert.match(authorise(policy, tx(A(2), A(10), iface.usdc.encodeFunctionData("mint", [A(2), 1n]))).reason, /not allowed/);
  assert.match(authorise(policy, tx(A(2), A(11), iface.guard.encodeFunctionData("configure", [A(20), 1n]))).reason, /not allowed/);
  assert.match(authorise(policy, tx(A(2), A(99), iface.vault.encodeFunctionData("unwind", []))).reason, /allowlist/);
});

test("an agent executes only on its own vault", () => {
  const data = iface.vault.encodeFunctionData("execute", [A(13), "0x"]);
  assert.equal(authorise(policy, tx(A(3), A(20), data)).ok, true);
  assert.match(authorise(policy, tx(A(3), A(21), data)).reason, /allowlist/);
  assert.match(authorise(policy, tx(A(3), A(20), iface.vault.encodeFunctionData("withdraw", [1n, A(3)]))).reason, /not allowed/);
});

test("owner, strangers, value transfers and empty calldata are refused", () => {
  const data = iface.guard.encodeFunctionData("poke", [A(20), A(13)]);
  assert.equal(authorise(policy, tx(A(1), A(11), data)).reason, "unknown account");
  assert.equal(authorise(policy, tx(A(77), A(11), data)).reason, "unknown account");
  assert.match(authorise(policy, tx(A(9), A(11), data, { value: "0x1" })).reason, /value/);
  assert.equal(authorise(policy, tx(A(9), A(11), data, { value: "0x0" })).ok, true);
  assert.equal(authorise(policy, tx(A(9), A(11), "0x")).reason, "missing calldata");
  assert.equal(authorise(policy, null).reason, "malformed transaction");
});

test("addresses match case-insensitively", () => {
  const data = iface.guard.encodeFunctionData("observe", [A(20), A(13)]);
  const upper = (a) => `0x${a.slice(2).toUpperCase()}`;
  assert.equal(authorise(policy, tx(upper(A(9)), upper(A(11)), data)).ok, true);
});

// --- a deployment with a batch allocator -----------------------------------
const batchAbi = [
  "function depositEscrow(uint256)", "function withdrawEscrow(uint256)", "function setVaultAllowed(address,bool)",
  "function claimShares((address,address,uint256,uint256,uint256,uint256,uint256),bytes32[])"
];
const withBatch = buildPolicy({ ...deployment, chainId: 10143, abis: { ...abis, batch: batchAbi }, batch: { address: A(50) } });
const batchIface = new Interface(batchAbi);
const intent = (extra = {}) => ({
  allocator: A(2), vault: A(20), amount: "500000000", minShares: "1", epoch: "3", nonce: "7", deadline: "2000", ...extra
});
const typed = (extra = {}) => ({
  types: { EIP712Domain: [], ...intentTypes },
  domain: intentDomain(10143, A(50)),
  primaryType: "AllocationIntent",
  message: intent(),
  ...extra
});

test("a deployment without a batch allocator grants nothing on one and signs no typed data", () => {
  assert.equal(policy.intents, null);
  assert.match(authorise(policy, tx(A(2), A(50), batchIface.encodeFunctionData("depositEscrow", [1n]))).reason, /allowlist/);
  assert.match(authoriseTypedData(policy, A(2), typed()).reason, /no batch allocator/);
});

test("allocator may fund, empty and claim from the batch allocator, and nobody else may", () => {
  const call = (from, fn, args) => authorise(withBatch, tx(from, A(50), batchIface.encodeFunctionData(fn, args)));
  assert.equal(call(A(2), "depositEscrow", [1n]).ok, true);
  assert.equal(call(A(2), "withdrawEscrow", [1n]).ok, true);
  assert.equal(call(A(2), "claimShares", [Object.values(intent()), []]).ok, true);
  assert.match(call(A(2), "setVaultAllowed", [A(20), true]).reason, /not allowed/);
  assert.match(call(A(9), "depositEscrow", [1n]).reason, /allowlist/);
  assert.match(call(A(3), "claimShares", [Object.values(intent()), []]).reason, /allowlist/);
  // The rest of the policy is unchanged by the batch rules.
  assert.deepEqual(withBatch.accounts, policy.accounts);
  assert.equal(authorise(withBatch, tx(A(2), A(10), iface.usdc.encodeFunctionData("approve", [A(50), 1n]))).ok, true);
});

test("the allocator's intent for this deployment is signed, as a string or an object", () => {
  const verdict = authoriseTypedData(withBatch, A(2), JSON.stringify(typed()));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.intent, intent());
  assert.equal(authoriseTypedData(withBatch, A(2).toUpperCase().replace("0X", "0x"), typed()).ok, true);
  // ethers sends the chain id as a number, a wallet may send it as a hex string.
  assert.equal(authoriseTypedData(withBatch, A(2), typed({ domain: { ...intentDomain("0x279f", A(50)) } })).ok, true);
});

test("typed data for another signer, domain, type or vault is refused", () => {
  const reason = (address, extra) => authoriseTypedData(withBatch, address, typed(extra)).reason;
  assert.match(reason(A(9), {}), /only the allocator/);
  assert.match(reason(A(3), {}), /only the allocator/);
  assert.match(reason(A(2), { domain: intentDomain(10143, A(51)) }), /another domain/);
  assert.match(reason(A(2), { domain: intentDomain(1, A(50)) }), /another domain/);
  assert.match(reason(A(2), { domain: { ...intentDomain(10143, A(50)), name: "USD Coin" } }), /another domain/);
  assert.match(reason(A(2), { domain: { ...intentDomain(10143, A(50)), version: "2" } }), /another domain/);
  assert.match(reason(A(2), { domain: { ...intentDomain(10143, A(50)), salt: `0x${"00".repeat(32)}` } }), /another domain/);
  assert.match(reason(A(2), { domain: { ...intentDomain(10143, A(50)), chainId: "testnet" } }), /another domain/);
  assert.match(reason(A(2), { primaryType: "Permit" }), /only AllocationIntent/);
  assert.match(reason(A(2), { types: { AllocationIntent: [{ name: "owner", type: "address" }] } }), /fields/);
  assert.match(reason(A(2), { message: intent({ allocator: A(9) }) }), /another allocator/);
  assert.match(reason(A(2), { message: intent({ vault: A(99) }) }), /outside this deployment/);
  assert.match(reason(A(2), { message: intent({ amount: "0" }) }), /greater than zero/);
  assert.match(reason(A(2), { message: { ...intent(), nonce: undefined } }), /missing nonce/);
  assert.equal(authoriseTypedData(withBatch, A(2), "{not json").reason, "malformed typed data");
  assert.equal(authoriseTypedData(withBatch, A(2), null).reason, "malformed typed data");
  assert.equal(authoriseTypedData(withBatch, A(2), { primaryType: "AllocationIntent" }).reason, "malformed typed data");
});

test("on contracts with the lifecycle calls, allocator and keeper may freeze an unobservable vault and accrue fees", () => {
  const newer = {
    ...deployment,
    abis: {
      ...abis,
      guard: [...abis.guard, "function freezeUnobservable(address) returns (uint256)"],
      vault: [...abis.vault, "function accrueFees() returns (uint256)"]
    }
  };
  const p = buildPolicy(newer);
  const g = new Interface(newer.abis.guard);
  const v = new Interface(newer.abis.vault);
  for (const from of [A(2), A(9)]) {
    assert.equal(authorise(p, tx(from, A(11), g.encodeFunctionData("freezeUnobservable", [A(20)]))).ok, true);
    assert.equal(authorise(p, tx(from, A(21), v.encodeFunctionData("accrueFees", []))).ok, true);
  }
  // An agent still signs execute() on its own vault and nothing else.
  assert.match(authorise(p, tx(A(3), A(11), g.encodeFunctionData("freezeUnobservable", [A(20)]))).reason, /allowlist/);
  // Older contracts leave the calls out rather than failing to build a policy.
  assert.match(authorise(policy, tx(A(2), A(11), g.encodeFunctionData("freezeUnobservable", [A(20)]))).reason, /not allowed/);
});

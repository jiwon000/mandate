import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { authorise, buildPolicy } from "./live-policy.mjs";

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

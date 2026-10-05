import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, concat, keccak256 } from "ethers";
import { hashIntent, intentDomain, intentTypes } from "../contracts/tools/batch.mjs";
import {
  epochAt, epochEnd, normaliseIntent, planSettlement, settleable, settleableEpochs, settlementDeadline
} from "./intents.mjs";

const A = (n) => `0x${String(n).padStart(40, "0")}`;
const timing = { genesis: 1_000, epochDuration: 20, settlementWindow: 600 };
const domain = intentDomain(31337, A(50));
const raw = (extra = {}) => ({
  allocator: A(2), vault: A(20), amount: "500000000", minShares: "1", epoch: "3", nonce: "7", deadline: "2000", ...extra
});

test("an intent is kept as checksummed addresses and decimal strings", () => {
  const intent = normaliseIntent(raw({ vault: "0x00000000000000000000000000000000000000ab", amount: 5n, epoch: 3, nonce: "0x10" }));
  assert.equal(intent.vault, "0x00000000000000000000000000000000000000AB");
  assert.deepEqual([intent.amount, intent.epoch, intent.nonce], ["5", "3", "16"]);
  // The spelling does not change what was signed.
  assert.equal(hashIntent(domain, intent), hashIntent(domain, raw({ vault: intent.vault.toLowerCase(), amount: "5", nonce: "16" })));
});

test("malformed intents are refused with the field that is wrong", () => {
  assert.throws(() => normaliseIntent(null), /missing intent/);
  assert.throws(() => normaliseIntent({ ...raw(), nonce: undefined }), /missing nonce/);
  assert.throws(() => normaliseIntent(raw({ vault: "0x1234" })), /vault is not an address/);
  assert.throws(() => normaliseIntent(raw({ amount: "0" })), /greater than zero/);
  assert.throws(() => normaliseIntent(raw({ amount: "-1" })), /amount is not an integer/);
  assert.throws(() => normaliseIntent(raw({ amount: "1.5" })), /amount is not an integer/);
  assert.throws(() => normaliseIntent(raw({ epoch: 1.5 })), /epoch is not an integer/);
  assert.throws(() => normaliseIntent(raw({ deadline: { toString: () => "1" } })), /deadline is not an integer/);
  assert.throws(() => normaliseIntent(raw({ nonce: `0x1${"0".repeat(64)}` })), /nonce is out of range/);
});

test("an epoch settles from its end until the settlement window closes", () => {
  assert.equal(epochAt(timing, 999), 0);
  assert.equal(epochAt(timing, 1_061), 3);
  assert.equal(epochEnd(timing, 3), 1_080);
  assert.equal(settlementDeadline(timing, 3), 1_680);
  assert.equal(settleable(timing, 3, 1_079), false);
  assert.equal(settleable(timing, 3, 1_080), true);
  assert.equal(settleable(timing, 3, 1_680), true);
  assert.equal(settleable(timing, 3, 1_681), false);
  const entries = [5, 3, 3, 40, 0].map((epoch) => ({ intent: raw({ epoch: String(epoch) }) }));
  // At 1,700 epoch 0 and 3 are past their window, 40 has not ended, 5 is open.
  assert.deepEqual(settleableEpochs(timing, entries, 1_700), [5]);
  assert.deepEqual(settleableEpochs(timing, entries, 1_130), [0, 3, 5]);
});

test("a settlement orders vaults by address and proves every intent against the root", async () => {
  const signer = Wallet.createRandom();
  const entry = async (extra) => {
    const intent = normaliseIntent(raw({ allocator: signer.address, ...extra }));
    return { intent, signature: await signer.signTypedData(domain, intentTypes, intent) };
  };
  const entries = [
    await entry({ vault: A(22), nonce: "1" }),
    await entry({ vault: A(20), nonce: "2" }),
    await entry({ vault: A(22), nonce: "3" })
  ];
  const plan = planSettlement(domain, entries);
  assert.deepEqual(plan.vaults, [A(20), A(22)]);
  assert.deepEqual(plan.nets.map((net) => net.intents.map((signed) => signed.intent.nonce)), [["2"], ["1", "3"]]);
  assert.deepEqual(plan.claims.map((claim) => claim.intent.nonce), ["2", "1", "3"]);
  assert.equal(plan.nets[1].intents[0].signature, entries[0].signature);

  // The same walk BatchAllocator.claimShares() does: sorted pairs up to the root.
  const pair = (a, b) => keccak256(concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
  for (const claim of plan.claims) {
    assert.equal(claim.digest, hashIntent(domain, claim.intent));
    const computed = claim.proof.reduce((node, sibling) => pair(node, sibling), keccak256(claim.digest));
    assert.equal(computed, plan.root);
  }
  assert.throws(() => planSettlement(domain, []), /no intents/);
});

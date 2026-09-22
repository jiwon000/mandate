import assert from "node:assert/strict";
import test from "node:test";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, ZeroHash } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";
import { buildIntentTree, hashIntent, intentDomain, intentTypes } from "../tools/batch.mjs";

const compiled = compileContracts();

// Every vault gets a first deposit from the owner, so the batch path is never the
// first depositor: MandateVault locks MIN_SHARES out of that deposit, and these
// tests count shares one unit at a time.
const SEED = 3_000_000n;

async function fixture(t) {
  const chain = await hre.network.create();
  t.after(() => chain.close());
  const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, alice, bob, agent] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  async function deploy(source, name, args = []) {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    const contract = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  const usdc = await deploy("mocks/MockUSDC", "MockUSDC");
  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  // The batch path never trades, but a vault prices its shares through its adapter,
  // so it needs a real one even when the position is always flat.
  const venue = await deploy("mocks/DeterministicMockVenue", "DeterministicMockVenue", [10n ** 21n]);
  const adapter = await deploy("MockVenueAdapter", "MockVenueAdapter", [venue.target]);
  const vaults = [];
  for (let i = 0; i < 2; i++) {
    vaults.push(
      await deploy("MandateVault", "MandateVault", [usdc.target, guard.target, agent.address, adapter.target])
    );
  }
  vaults.sort((a, b) => BigInt(a.target) < BigInt(b.target) ? -1 : 1);
  for (const vault of vaults) {
    await (await usdc.mint(owner.address, SEED)).wait();
    await (await usdc.approve(vault.target, SEED)).wait();
    await (await vault.allocate(SEED, owner.address)).wait();
  }
  const batch = await deploy("BatchAllocator", "BatchAllocator", [usdc.target, owner.address, 1000, 500]);
  for (const vault of vaults) await (await batch.setVaultAllowed(vault.target, true)).wait();
  for (const user of [alice, bob]) {
    await (await usdc.mint(user.address, 1000n)).wait();
    await (await usdc.connect(user).approve(batch.target, 1000n)).wait();
    await (await batch.connect(user).depositEscrow(1000n)).wait();
  }
  const domain = intentDomain(31337, batch.target);
  const end = await batch.epochEnd(0);
  const deadline = await batch.settlementDeadline(0);
  async function signed(user = alice, overrides = {}, domainOverride = domain) {
    const intent = {
      allocator: user.address, vault: vaults[0].target, amount: 100n,
      minShares: 1n, epoch: 0n, nonce: 0n, deadline, ...overrides,
    };
    return { intent, signature: await user.signTypedData(domainOverride, intentTypes, intent) };
  }
  function build(entries) {
    const nets = [];
    for (const entry of [...entries].sort((a, b) => BigInt(a.intent.vault) < BigInt(b.intent.vault) ? -1 : BigInt(a.intent.vault) > BigInt(b.intent.vault) ? 1 : 0)) {
      if (nets.at(-1)?.vault !== entry.intent.vault) nets.push({ vault: entry.intent.vault, intents: [] });
      nets.at(-1).intents.push(entry);
    }
    const intents = nets.flatMap((net) => net.intents.map((entry) => entry.intent));
    return { nets, intents, ...buildIntentTree(domain, intents) };
  }
  async function at(timestamp) {
    await chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
    await chain.provider.request({ method: "evm_mine", params: [] });
  }
  async function settle(data) {
    return (await batch.settleEpoch(0, data.root, data.nets, { gasLimit: 8_000_000 })).wait();
  }
  async function pristine() {
    assert.equal(await batch.totalEscrow(), 2000n);
    assert.equal(await usdc.balanceOf(batch.target), 2000n);
    assert.equal(await batch.escrowOf(alice.address), 1000n);
    assert.equal(await batch.escrowOf(bob.address), 1000n);
    assert.equal(await batch.settled(0), false);
    assert.equal(await batch.intentRootOf(0), ZeroHash);
    for (const vault of vaults) {
      assert.equal(await vault.totalSupply(), SEED);
      assert.equal(await usdc.allowance(batch.target, vault.target), 0n);
    }
  }
  return { chain, provider, owner, alice, bob, agent, usdc, guard, vaults, batch, domain, end, deadline, signed, build, at, settle, pristine };
}

test("multi-user, multi-vault netting; public proofs; permissionless claims; withdrawal", async (t) => {
  const f = await fixture(t);
  const { alice, bob, agent, vaults, batch, usdc } = f;
  const data = f.build([
    await f.signed(alice, { amount: 101n }),
    await f.signed(bob, { amount: 203n }),
    await f.signed(alice, { vault: vaults[1].target, amount: 97n, nonce: 1n }),
  ]);
  assert.equal(await batch.hashIntent(data.intents[0]), hashIntent(f.domain, data.intents[0]));
  await assert.rejects(f.settle(data)); // Too early: actual mined revert.
  await f.at(f.end);
  await assert.rejects(batch.connect(agent).settleEpoch.staticCall(0, data.root, data.nets));
  const receipt = await f.settle(data);
  const allocations = receipt.logs.filter((log) => {
    try { return batch.interface.parseLog(log)?.name === "VaultAllocated"; } catch { return false; }
  });
  assert.equal(allocations.length, 2, "one deposit per vault, not per intent");
  assert.equal(await batch.totalEscrow(), 1599n);
  assert.equal(await usdc.balanceOf(batch.target), 1599n);
  assert.equal(await batch.escrowOf(alice.address), 802n);
  assert.equal(await batch.escrowOf(bob.address), 797n);
  assert.equal(await vaults[0].totalSupply(), SEED + 304n);
  assert.equal(await vaults[1].totalSupply(), SEED + 97n);
  assert.equal(await batch.intentRootOf(0), data.root);
  await assert.rejects(f.settle(data));
  await assert.rejects(batch.claimShares.staticCall(data.intents[0], [ZeroHash]));
  await assert.rejects(batch.claimShares.staticCall({ ...data.intents[0], allocator: agent.address }, data.proofs[0]));
  await f.at(f.deadline + 1000n); // Claims survive intent/settlement expiry.
  for (let i = 0; i < data.intents.length; i++) {
    const intent = data.intents[i];
    const vault = vaults.find((v) => v.target === intent.vault);
    await (await batch.connect(agent).claimShares(intent, data.proofs[i])).wait();
    assert.equal(await vault.balanceOf(intent.allocator), intent.amount);
    await assert.rejects(batch.claimShares.staticCall(intent, data.proofs[i]));
  }
  for (const vault of vaults) {
    assert.equal(await vault.balanceOf(batch.target), 0n);
    assert.equal(await batch.outstandingShares(vault.target), 0n);
    assert.equal(await usdc.allowance(batch.target, vault.target), 0n);
    await assert.rejects(vault.connect(agent).withdraw.staticCall(1n, agent.address));
    for (const user of [alice, bob]) {
      const shares = await vault.balanceOf(user.address);
      if (shares) await (await vault.connect(user).withdraw(shares, user.address)).wait();
    }
  }
  for (const user of [alice, bob]) {
    await (await batch.connect(user).withdrawEscrow(await batch.escrowOf(user.address))).wait();
    assert.equal(await usdc.balanceOf(user.address), 1000n);
  }
  assert.equal(await batch.totalEscrow(), 0n);
});

test("forgery, wrong domain, wrong root, duplicates and minimum shares revert all effects", async (t) => {
  const f = await fixture(t);
  await f.at(f.end);
  const good = await f.signed();
  const cases = [
    { ...good, intent: { ...good.intent, amount: 101n } },
    await f.signed(f.alice, {}, { ...f.domain, chainId: 1 }),
    await f.signed(f.alice, {}, { ...f.domain, verifyingContract: f.vaults[0].target }),
    await f.signed(f.alice, { minShares: 101n }),
    await f.signed(f.alice, { amount: 1001n }),
    await f.signed(f.alice, { deadline: f.end - 1n }),
    await f.signed(f.alice, { epoch: 1n }),
  ];
  for (const entry of cases) {
    await assert.rejects(f.settle(f.build([entry])));
    await f.pristine();
    assert.equal(await f.batch.nonceUsed(f.alice.address, 0), false);
  }
  const data = f.build([good]);
  await assert.rejects(f.settle({ ...data, root: ZeroHash }));
  await f.pristine();
  await assert.rejects(f.settle(f.build([good, good])));
  await f.pristine();
  // A late failure in the second vault must roll back the first vault's deposit too.
  const badSecond = await f.signed(f.bob, { vault: f.vaults[1].target, minShares: 101n });
  await assert.rejects(f.settle(f.build([good, badSecond])));
  await f.pristine();
  await f.settle(data); // Reverted nonce remains usable.
});

test("cancellation, escrow withdrawal and hard epoch deadline need no batcher cooperation", async (t) => {
  const f = await fixture(t);
  const data = f.build([await f.signed()]);
  await (await f.batch.connect(f.alice).cancelIntent(0)).wait();
  await f.at(f.end);
  await assert.rejects(f.settle(data));
  await f.pristine();
  const other = f.build([await f.signed(f.bob)]);
  await (await f.batch.connect(f.bob).withdrawEscrow(1000n)).wait();
  await assert.rejects(f.settle(other));
  await assert.rejects(f.batch.connect(f.bob).withdrawEscrow.staticCall(1n));
  await f.at(f.deadline + 1n);
  const late = f.build([await f.signed(f.alice, { nonce: 1n, deadline: f.deadline + 1000n })]);
  await assert.rejects(f.settle(late));
  await (await f.batch.connect(f.alice).withdrawEscrow(1000n)).wait();
  assert.equal(await f.batch.totalEscrow(), 0n);
  assert.equal(await f.usdc.balanceOf(f.batch.target), 0n);
});

test("rounding assigns every minted share; disabling a vault does not block claims", async (t) => {
  const f = await fixture(t);
  const vault = f.vaults[0];
  await (await f.usdc.mint(f.owner.address, 4_000_000n)).wait();
  await (await f.usdc.transfer(vault.target, 4_000_000n)).wait(); // Supply=3e6, assets=7e6.
  const data = f.build([
    await f.signed(f.alice, { amount: 4n }),
    await f.signed(f.bob, { amount: 4n }),
    await f.signed(f.alice, { amount: 5n, nonce: 1n }),
  ]);
  await f.at(f.end);
  await f.settle(data); // floor(13 * 3e6 / 7e6) = 5 shares, entitlements 1, 2, 2.
  assert.equal(await vault.balanceOf(f.batch.target), 5n);
  assert.equal(await f.batch.outstandingShares(vault.target), 5n);
  const expected = [1n, 2n, 2n];
  await (await f.batch.setVaultAllowed(vault.target, false)).wait();
  for (let i = 0; i < data.intents.length; i++) {
    assert.equal(await f.batch.claimableShares(hashIntent(f.domain, data.intents[i])), expected[i]);
    await (await f.batch.claimShares(data.intents[i], data.proofs[i])).wait();
  }
  assert.equal(await vault.balanceOf(f.batch.target), 0n);
  assert.equal(await vault.balanceOf(f.alice.address), 3n);
  assert.equal(await vault.balanceOf(f.bob.address), 2n);
  assert.equal(await vault.totalSupply(), SEED + 5n);
});

test("batch shape, allowlist and caller checks reject malformed settlement", async (t) => {
  const f = await fixture(t);
  const a = await f.signed();
  const b = await f.signed(f.bob, { vault: f.vaults[1].target });
  const data = f.build([a, b]);
  await f.at(f.end);
  await assert.rejects(f.batch.connect(f.alice).setVaultAllowed.staticCall(f.vaults[0].target, false));
  await assert.rejects(f.settle({ root: ZeroHash, nets: [] }));
  await assert.rejects(f.settle({ ...data, nets: [...data.nets].reverse() }));
  await assert.rejects(f.settle({ ...data, nets: [data.nets[0], data.nets[0]] }));
  await assert.rejects(f.settle({ ...data, nets: [{ vault: f.vaults[0].target, intents: [b] }] }));
  await assert.rejects(f.settle({ root: data.root, nets: [{ vault: f.vaults[0].target, intents: Array(129).fill(a) }] }));
  await (await f.batch.setVaultAllowed(f.vaults[0].target, false)).wait();
  await assert.rejects(f.settle(data));
  await f.pristine();
});

test("spent nonces cannot be reused across vaults or later epochs", async (t) => {
  const f = await fixture(t);
  const first = f.build([await f.signed()]);
  await f.at(f.end);
  await f.settle(first);
  const end1 = await f.batch.epochEnd(1);
  const deadline1 = await f.batch.settlementDeadline(1);
  await f.at(end1);
  const replay = f.build([await f.signed(f.alice, {
    epoch: 1n, vault: f.vaults[1].target, deadline: deadline1,
  })]);
  await assert.rejects(async () => (await f.batch.settleEpoch(1, replay.root, replay.nets, { gasLimit: 8_000_000 })).wait());
  assert.equal(await f.batch.escrowOf(f.alice.address), 900n);
  assert.equal(await f.batch.settled(1), false);
  const fresh = f.build([await f.signed(f.alice, {
    epoch: 1n, vault: f.vaults[1].target, deadline: deadline1, nonce: 1n,
  })]);
  await (await f.batch.settleEpoch(1, fresh.root, fresh.nets)).wait();
  assert.equal(await f.batch.escrowOf(f.alice.address), 800n);
  assert.equal(await f.batch.settled(1), true);
  assert.equal(await f.batch.intentRootOf(0), first.root);
});

import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder, fixture, termsHashOf } from "./fixture.mjs";
import { buildIntentTree, intentDomain, intentTypes } from "../tools/batch.mjs";
import { DPReporter } from "../../reporter/reporter.mjs";

// One mandate's whole life on one chain, in the order a real run goes: the operator
// stands up the market, an agent registers its own mandate through the factory, one
// allocator deposits directly and another through a signed batch intent, the agent
// trades inside its terms and is refused outside them, the price drops past the
// drawdown limit, a keeper freezes the vault, an outsider unwinds it to Closed, both
// allocators withdraw, and the reporter posts a noised leaderboard release. Every
// other suite tests one of these steps; this one checks they compose.

const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);

function eventsNamed(receipt, contract, name) {
  return receipt.logs
    .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .filter((parsed) => parsed?.name === name);
}

function revertsWith(contract, name) {
  const selector = contract.interface.getError(name).selector;
  return (error) => error?.revert?.name === name || String(error?.message).includes(selector);
}

test("end to end: agent registration, two deposits, trading, freeze, unwind, withdrawal, DP release", async (t) => {
  // lockTerms: false leaves the fixture's own vault unfunded; the journey uses a
  // vault the agent creates through the factory instead.
  const f = await fixture(t, {}, { lockTerms: false });
  const { owner, agent, keeper, outsider, usdc, guard, venue, adapterAddress } = f;
  const [alice, bob] = [f.allocator, await f.provider.getSigner(5)];
  const { chainId } = await f.provider.getNetwork();

  // 1. Operator: registry, factory, canonical guard, listed adapter, reporter, ε cap.
  const registry = await f.deploy("MandateRegistry", "MandateRegistry");
  const factory = await f.deploy("MandateFactory", "MandateFactory", [
    await usdc.getAddress(), await guard.getAddress(), await registry.getAddress()
  ]);
  await (await guard.setFactory(await factory.getAddress())).wait();
  await (await registry.setCanonicalGuard(await guard.getAddress())).wait();
  await (await registry.setFactory(await factory.getAddress())).wait();
  await (await factory.listAdapter(adapterAddress, true)).wait();
  await (await registry.setReporter(await keeper.getAddress())).wait();
  await (await registry.setEpsilonCap(5_000_000n)).wait();

  // 2. Agent registration: the agent creates its own mandate. Terms are locked and the
  //    vault is cataloged under the agent in the same transaction.
  const trade = { ...DEFAULT_TRADE, maxTradesPerDay: 10 };
  const modelHash = keccak256(toUtf8Bytes("rule-based momentum v1"));
  const created = await (await factory.connect(agent).createMandate({
    agent: await agent.getAddress(), adapter: adapterAddress,
    limits: BASE_LIMITS, trade, fees: NO_FEES, modelHash
  })).wait();
  const [mandate] = eventsNamed(created, factory, "MandateCreated");
  const vault = f.vault.attach(mandate.args.vault);
  const vaultAddress = await vault.getAddress();

  assert.equal(await guard.termsLocked(vaultAddress), true);
  assert.equal(await vault.agent(), await agent.getAddress());
  const entry = await registry.agentOf(vaultAddress);
  assert.equal(entry.termsHash, termsHashOf(BASE_LIMITS, trade, NO_FEES));
  assert.equal(entry.termsHash, await guard.termsHash(vaultAddress), "registry and guard agree on the terms");
  assert.deepEqual([...(await registry.vaultsOf(await agent.getAddress()))], [vaultAddress]);
  // The terms cannot be rewritten once money can come in.
  await assert.rejects(guard.configure(vaultAddress, BASE_LIMITS));

  // 3a. Alice deposits 1,000 mUSDC directly. First deposit locks MIN_SHARES.
  await (await usdc.mint(alice.address, usd(1000))).wait();
  await (await usdc.connect(alice).approve(vaultAddress, usd(1000))).wait();
  await (await vault.connect(alice).allocate(usd(1000), alice.address)).wait();
  const aliceShares = await vault.balanceOf(alice.address);
  assert.equal(aliceShares, usd(1000) - 1000n);

  // 3b. Bob deposits 500 mUSDC through a signed intent in a batch epoch.
  const batch = await f.deploy("BatchAllocator", "BatchAllocator", [await usdc.getAddress(), owner.address, 1000, 500]);
  await (await batch.setVaultAllowed(vaultAddress, true)).wait();
  await (await usdc.mint(bob.address, usd(500))).wait();
  await (await usdc.connect(bob).approve(batch.target, usd(500))).wait();
  await (await batch.connect(bob).depositEscrow(usd(500))).wait();
  const domain = intentDomain(chainId, batch.target);
  const intent = {
    allocator: bob.address, vault: vaultAddress, amount: usd(500),
    minShares: usd(499), epoch: 0n, nonce: 0n, deadline: await batch.settlementDeadline(0)
  };
  const signature = await bob.signTypedData(domain, intentTypes, intent);
  const tree = buildIntentTree(domain, [intent]);
  await f.chain.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(await batch.epochEnd(0))] });
  await f.chain.provider.request({ method: "evm_mine", params: [] });
  await (await venue.setPrice(e18(2000))).wait(); // a keeper re-stamps the mark before settling
  await (await batch.settleEpoch(0, tree.root, [{ vault: vaultAddress, intents: [{ intent, signature }] }], { gasLimit: 8_000_000 })).wait();
  await (await batch.connect(outsider).claimShares(intent, tree.proofs[0])).wait();
  const bobShares = await vault.balanceOf(bob.address);
  assert.equal(bobShares, usd(500), "flat vault: one share per unit");
  assert.equal(await batch.escrowOf(bob.address), 0n);
  assert.equal(await usdc.balanceOf(vaultAddress), usd(1500));

  // 4. The agent trades inside its terms and is refused outside them.
  const order = (size, limit) => coder.encode(["int256", "uint256"], [e18(size), e18(limit)]);
  await (await vault.connect(agent).execute(adapterAddress, order(0.5, 2100))).wait();
  assert.equal(await venue.positionSizeE18(vaultAddress), e18(0.5));
  // $2,200 order against a $2,000 order cap.
  await assert.rejects(vault.connect(agent).execute(adapterAddress, order(1.1, 2100)), revertsWith(guard, "OrderNotionalExceeded"));
  await assert.rejects(vault.connect(outsider).execute(adapterAddress, order(0.1, 2100)));
  const navBefore = (await vault.markedAssets())[0];

  // 5. The price falls 10%: $100 down on $1,500 of equity, past the 2% drawdown limit.
  //    A keeper's poke freezes the vault and is paid for it.
  await (await venue.setPrice(e18(1800))).wait();
  const keeperBefore = await usdc.balanceOf(keeper.address);
  await (await guard.connect(keeper).poke(vaultAddress, adapterAddress)).wait();
  assert.equal(await vault.state(), 1n, "Frozen");
  const pokeBounty = (await usdc.balanceOf(keeper.address)) - keeperBefore;
  assert.ok(pokeBounty > 0n, "the keeper is paid");
  await assert.rejects(vault.connect(agent).execute(adapterAddress, order(-0.1, 1700)));
  await assert.rejects(vault.connect(alice).allocate(1n, alice.address));

  // 6. Anyone unwinds: five steps take the position off and close the vault.
  for (let step = 1; step <= 5; step += 1) await (await vault.connect(outsider).unwind()).wait();
  assert.equal(await venue.positionSizeE18(vaultAddress), 0n);
  assert.equal(await vault.state(), 2n, "Closed");
  const unwindBounties = await usdc.balanceOf(outsider.address);
  assert.ok(unwindBounties > 0n);

  // 7. Both allocators leave with their pro-rata share of what is left.
  const cash = await usdc.balanceOf(vaultAddress);
  const [equity] = await f.adapter.markEquity(vaultAddress);
  assert.equal(equity, cash - usd(100), "the $100 loss is realised at the venue");
  const supply = await vault.totalSupply();
  await (await vault.connect(alice).withdraw(aliceShares, alice.address)).wait();
  await (await vault.connect(bob).withdraw(bobShares, bob.address)).wait();
  const alicePaid = await usdc.balanceOf(alice.address);
  const bobPaid = await usdc.balanceOf(bob.address);
  assert.equal(alicePaid, (aliceShares * equity) / supply);
  assert.equal(bobPaid, (bobShares * (equity - alicePaid)) / (supply - aliceShares));
  // No mUSDC created or lost on the way. The mock venue books the $100 loss against
  // the vault without moving tokens, so it stays in the vault's balance with the
  // locked first shares' slice.
  const residual = await usdc.balanceOf(vaultAddress);
  assert.equal(pokeBounty + unwindBounties + alicePaid + bobPaid + residual, usd(1500));
  assert.ok(residual - usd(100) < usd(1), "only the locked shares' sliver is left in equity");
  assert.equal(await vault.totalSupply(), 1000n, "only the locked first shares remain");

  // 8. The reporter posts a noised, signed release for the epoch. Anyone may relay it;
  //    the registry checks the reporter's signature and the ε ledger.
  const dpReporter = new DPReporter({
    reporterSecret: "e2e-secret", signer: keeper, registryAddress: await registry.getAddress(),
    chainId, cap: 5_000_000n, clipBound: 0.1, epsilon: 0.5, statsVersion: 1
  });
  const navAfter = Number(equity) / 1e6;
  const { release, signature: releaseSig } = await dpReporter.buildRelease({
    epoch: 0, pinnedBlock: await f.provider.getBlockNumber(),
    perTradeReturns: [navAfter / (Number(navBefore) / 1e6) - 1],
    navSeries: [Number(navBefore) / 1e6, navAfter]
  });
  await assert.rejects(registry.connect(outsider).postLeaderboard(
    release.epoch, release.pinnedBlock, keccak256(toUtf8Bytes("tampered")), release.epsilonPerfE6,
    release.epsilonIntentE6, release.cumulativeEpsilonE6, releaseSig
  ));
  await (await registry.connect(outsider).postLeaderboard(
    release.epoch, release.pinnedBlock, release.statsDigest, release.epsilonPerfE6,
    release.epsilonIntentE6, release.cumulativeEpsilonE6, releaseSig
  )).wait();
  assert.equal(await registry.cumulativeEpsilonE6(), release.cumulativeEpsilonE6);
  assert.equal((await registry.releaseOf(0n)).statsDigest, release.statsDigest);
});

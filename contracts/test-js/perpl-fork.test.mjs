import assert from "node:assert/strict";
import test from "node:test";
import hre from "hardhat";
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { artifact, compileContracts } from "../tools/compiler.mjs";
import { BASE_LIMITS, DEFAULT_TRADE, NO_FEES, coder } from "./fixture.mjs";

// The whole Mandate stack against Perpl's real exchange, on a local fork of Monad
// testnet. Nothing is sent to the network: the fork reads state over RPC and every
// transaction stays in the in-process chain. Opt in with PERPL_FORK=1, since it needs
// the RPC (PERPL_FORK_RPC overrides https://testnet-rpc.monad.xyz).
//
// Perpl refuses orders against a mark older than 60s and the guard does the same, so
// the test pins each block's timestamp a second after the last instead of letting
// wall-clock time run while the fork fetches state. The whole run spends about 25 of
// those 60 seconds, so it forks only once the testnet mark is at most 10s old.

const RPC = process.env.PERPL_FORK_RPC ?? "https://testnet-rpc.monad.xyz";
const EXCHANGE = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const PERP_IDS = [16, 32, 48, 64]; // BTC, ETH, SOL, MON
const HOLDING_TIME = 4n;
const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)"
];

/// Fork Monad testnet at a block whose BTC mark is at most 10s old, trying again
/// for up to two minutes.
async function forkWithFreshMark(abi) {
  for (let i = 0; i < 40; i++) {
    const chain = await hre.network.create({ override: { forking: { url: RPC, enabled: true } } });
    const provider = new BrowserProvider(chain.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const exchange = new Contract(EXCHANGE, abi, provider);
    const [latest, info] = await Promise.all([provider.getBlock("latest"), exchange.getPerpetualInfoV2(16)]);
    if (latest.timestamp - Number(info.markTimestamp) <= 10) return { chain, provider, exchange, latest, info };
    await chain.close();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Perpl's testnet BTC mark stayed older than 10s for two minutes");
}

test("a Perpl-backed mandate trades, is refused past its cap, freezes and unwinds on Perpl", {
  skip: process.env.PERPL_FORK !== "1" && "set PERPL_FORK=1 to run against a Monad testnet fork",
  timeout: 600_000
}, async (t) => {
  const compiled = compileContracts();
  const exchangeAbi = artifact(compiled, "contracts/src/perpl/IPerplExchange.sol", "IPerplExchange").abi;
  const { chain, provider, exchange, latest, info } = await forkWithFreshMark(exchangeAbi);
  t.after(() => chain.close());
  const rpc = (method, params = []) => chain.provider.request({ method, params });
  const [owner, allocator, agent, keeper] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  let now = Math.max(latest.timestamp, Number(info.markTimestamp)) + 1;
  const tick = (seconds = 1) => { now += seconds; return rpc("evm_setNextBlockTimestamp", [now]); };
  const send = async (txPromiseFactory, seconds) => { await tick(seconds); return (await txPromiseFactory()).wait(); };

  async function deploy(source, name, args = []) {
    const { abi, bytecode } = artifact(compiled, `contracts/src/${source}.sol`, name);
    await tick();
    const contract = await new ContractFactory(abi, bytecode, owner).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }

  const guard = await deploy("MandateRiskGuard", "MandateRiskGuard");
  const registry = await deploy("MandateRegistry", "MandateRegistry");
  const adapter = await deploy("perpl/PerplAdapter", "PerplAdapter", [EXCHANGE, AUSD, 200, 300, PERP_IDS]);
  const factory = await deploy("MandateFactory", "MandateFactory", [
    AUSD, await guard.getAddress(), await registry.getAddress()
  ]);
  const adapterAddress = await adapter.getAddress();
  await send(() => guard.setFactory(factory.target));
  await send(() => registry.setCanonicalGuard(guard.target));
  await send(() => registry.setFactory(factory.target));
  await send(() => factory.listAdapter(adapterAddress, true));

  const limits = {
    ...BASE_LIMITS,
    maxOrderNotional: e18(1_000), maxBlockNotional: e18(1_000),
    maxPositionNotional: e18(200), maxTotalNotional: e18(1_000)
  };
  const receipt = await send(() => factory.connect(agent).createMandate({
    agent: agent.address, adapter: adapterAddress, limits,
    trade: { ...DEFAULT_TRADE, maxHoldingSeconds: 5 }, fees: NO_FEES,
    modelHash: keccak256(toUtf8Bytes("perpl fork"))
  }));
  const created = receipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "MandateCreated");
  const { abi: vaultAbi } = artifact(compiled, "contracts/src/MandateVault.sol", "MandateVault");
  const vault = new Contract(created.args.vault, vaultAbi, owner);

  // Perpl's exchange holds the testnet aUSD; it funds the allocator.
  const ausd = new Contract(AUSD, ERC20, provider);
  await rpc("hardhat_setBalance", [EXCHANGE, "0x56BC75E2D63100000"]);
  await rpc("hardhat_impersonateAccount", [EXCHANGE]);
  const whale = new JsonRpcSigner(provider, EXCHANGE);
  await send(() => ausd.connect(whale).transfer(allocator.address, usd(500)));
  await send(() => ausd.connect(allocator).approve(vault.target, usd(500)));
  await send(() => vault.connect(allocator).allocate(usd(500), allocator.address));

  // 0.001 BTC long at mark + 1%. The adapter opens the vault's Perpl account (100 aUSD
  // minimum), Perpl locks the position's margin, and the rest comes back to the vault.
  const mark = (await adapter.marketPrice(0))[0];
  await send(() => vault.connect(agent).execute(adapterAddress,
    coder.encode(["int256", "uint256"], [e18("0.001"), (mark * 101n) / 100n])));
  const sub = await adapter.subaccountOf(vault.target);
  const account = await exchange.getAccountByAddr(sub);
  assert.notEqual(account.accountId, 0n);
  const [position] = await exchange.getPositionV2(16, account.accountId);
  assert.equal(position.lotLNS, 100n);
  assert.equal(position.positionType, 0n);
  const [positionNotional] = await adapter.positionState(vault.target);
  assert.ok(positionNotional > e18(10) && positionNotional < e18(200));
  const [equity, markedAt] = await adapter.markEquity(vault.target);
  assert.ok(equity > usd(495) && equity <= usd(500), `equity ${equity}`);
  assert.ok(BigInt(now) - markedAt <= 60n);
  assert.ok((await ausd.balanceOf(vault.target)) < usd(500) - usd(40), "margin sits at Perpl");

  // Two more BTC would take the position past its $200 cap: the guard refuses it
  // before Perpl sees the order.
  await tick();
  await assert.rejects(
    vault.connect(agent).execute(adapterAddress, coder.encode(["int256", "uint256"], [e18("0.002"), (mark * 101n) / 100n])),
    (error) => String(error?.message).includes(guard.interface.getError("PositionNotionalExceeded").selector) ||
      error?.revert?.name === "PositionNotionalExceeded"
  );

  // Selling 0.002 takes the long through flat into a 0.001 short, which Perpl
  // records as positionType 1. The limit is 3% under the mark, the widest the
  // adapter's band allows: it funds the worst fill it accepts, so that edge is not
  // refused for want of collateral.
  await send(() => vault.connect(agent).execute(adapterAddress,
    coder.encode(["int256", "uint256"], [-e18("0.002"), (mark * 97n) / 100n])));
  assert.ok((await ausd.balanceOf(vault.target)) < usd(500) - usd(40), "excess collateral came back");
  const [flipped] = await exchange.getPositionV2(16, account.accountId);
  assert.equal(flipped.lotLNS, 100n);
  assert.equal(flipped.positionType, 1n);

  // Past the five-second holding limit anyone can freeze it, and unwind closes the
  // short on Perpl in slices until the vault is flat and Closed.
  await send(() => guard.connect(keeper).poke(vault.target, adapterAddress), 6);
  assert.equal(await vault.state(), 1n);
  assert.equal((await guard.freezeOf(vault.target))[0], HOLDING_TIME);
  for (let i = 0; i < 8 && (await vault.state()) !== 2n; i++) {
    await send(() => vault.connect(keeper).unwind());
  }
  assert.equal(await vault.state(), 2n);
  const [closed] = await exchange.getPositionV2(16, account.accountId);
  assert.equal(closed.lotLNS, 0n);

  // All of it is back in the vault less Perpl's fees, and the allocator takes it out.
  const back = await ausd.balanceOf(vault.target);
  assert.ok(back > usd(495), `vault holds ${back}`);
  const shares = await vault.balanceOf(allocator.address);
  // Hardhat's well-known accounts may already hold testnet aUSD; count the change.
  const before = await ausd.balanceOf(allocator.address);
  await send(() => vault.connect(allocator).withdraw(shares, allocator.address));
  // The vault's MIN_SHARES dead shares keep their sliver, under a thousandth of a cent.
  const dust = await ausd.balanceOf(vault.target);
  assert.ok(dust < 1_000n, `dust ${dust}`);
  assert.equal((await ausd.balanceOf(allocator.address)) - before, back - dust);
  // The Perpl account is empty: nothing of the vault's is left at the venue.
  assert.equal((await exchange.getAccountByAddr(sub)).balanceCNS, 0n);
});

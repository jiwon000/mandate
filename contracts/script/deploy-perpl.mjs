// Deploys a Mandate stack that trades on Perpl's testnet exchange, then optionally
// runs one small round trip through it. Two steps, run separately:
//
//   npm run deploy:perpl          guard, registry, PerplAdapter, factory, one mandate
//   npm run deploy:perpl -- smoke allocate aUSD, open 0.001 BTC, close it, withdraw
//
// The deployer key comes from PERPL_DEPLOYER_KEY, or from the `privateKey` field of
// the JSON file at PERPL_WALLET_FILE. It is never printed. The deployer is the
// factory owner, the mandate's operator and its agent, and the smoke step's
// allocator, so one funded wallet is enough: some MON for gas and, for the smoke
// step, at least SMOKE_AUSD aUSD (Perpl opens an account only with 100 aUSD or more).
//
// MONAD_RPC_URL defaults to the public testnet RPC. The script refuses any chain but
// 10143; a local fork started with `npx hardhat node --fork <rpc> --chain-id 10143`
// passes that check and is how this script was rehearsed.
import fs from "node:fs";
import path from "node:path";
import {
  AbiCoder, Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet,
  formatEther, formatUnits, keccak256, parseUnits, toUtf8Bytes
} from "ethers";
import { loadAbi, loadArtifact } from "./artifacts.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const EXCHANGE = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const PERP_IDS = [16, 32, 48, 64]; // BTC, ETH, SOL, MON; the mandate trades market 0
const VENUE_LEVERAGE_HDTHS = 200; // 2x at Perpl, as in the fork test
const MAX_ADVERSE_LIMIT_BPS = 300; // a limit at most 3% past the mark on the costly side
const e18 = (x) => parseUnits(String(x), 18);
const usd = (x) => parseUnits(String(x), 6);
const coder = AbiCoder.defaultAbiCoder();

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const {
  MONAD_RPC_URL = "https://testnet-rpc.monad.xyz",
  PERPL_DEPLOYER_KEY,
  PERPL_WALLET_FILE,
  PERPL_DEPLOYMENTS = path.join(root, "contracts/deployments/perpl-10143.json"),
  SMOKE_AUSD = "150"
} = process.env;
const step = process.argv[2] ?? "deploy";
if (!["deploy", "smoke"].includes(step)) throw new Error(`Unknown step "${step}". Use deploy or smoke.`);

function deployerKey() {
  if (PERPL_DEPLOYER_KEY) return PERPL_DEPLOYER_KEY;
  if (PERPL_WALLET_FILE) return JSON.parse(fs.readFileSync(PERPL_WALLET_FILE, "utf8")).privateKey;
  throw new Error("Set PERPL_DEPLOYER_KEY, or PERPL_WALLET_FILE to a JSON file with a privateKey field");
}

const provider = new JsonRpcProvider(MONAD_RPC_URL);
const wallet = new Wallet(deployerKey(), provider);
// Local nonces: the public RPC can answer eth_getTransactionCount from a node that has
// not yet seen the previous transaction, and this script sends several back to back.
const signer = new NonceManager(wallet);
const { chainId } = await provider.getNetwork();
if (chainId !== 10143n) throw new Error(`Chain ${chainId} is not Monad testnet (10143)`);
const ausd = new Contract(AUSD, ERC20, provider);
console.log(`Deployer ${wallet.address} on chain ${chainId}`);
console.log(`  ${formatEther(await provider.getBalance(wallet.address))} MON, ${formatUnits(await ausd.balanceOf(wallet.address), 6)} aUSD`);

const send = async (label, txPromise) => {
  const receipt = await (await txPromise).wait();
  console.log(`${label}: ${receipt.hash}`);
  return receipt;
};

if (step === "deploy") {
  if (fs.existsSync(PERPL_DEPLOYMENTS)) {
    throw new Error(`${PERPL_DEPLOYMENTS} exists. Move it aside to deploy a new stack.`);
  }
  async function deploy(relativePath, name, args = []) {
    const { abi, bytecode } = loadArtifact(relativePath, name);
    const contract = await new ContractFactory(abi, bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    console.log(`${name}: ${contract.target}`);
    return contract;
  }

  const guard = await deploy("MandateRiskGuard.sol", "MandateRiskGuard");
  const registry = await deploy("MandateRegistry.sol", "MandateRegistry");
  const adapter = await deploy("perpl/PerplAdapter.sol", "PerplAdapter",
    [EXCHANGE, AUSD, VENUE_LEVERAGE_HDTHS, MAX_ADVERSE_LIMIT_BPS, PERP_IDS]);
  const factory = await deploy("MandateFactory.sol", "MandateFactory", [AUSD, guard.target, registry.target]);
  await send("guard.setFactory", guard.setFactory(factory.target));
  await send("registry.setCanonicalGuard", registry.setCanonicalGuard(guard.target));
  await send("registry.setFactory", registry.setFactory(factory.target));
  await send("factory.listAdapter", factory.listAdapter(adapter.target, true));

  // The fork test's terms: BTC only, a $200 position cap, 2% drawdown, and the guard
  // refuses a mark older than 60 seconds, the same bound Perpl applies to orders.
  const limits = {
    maxLeverageX100: 300, maxDrawdownBps: 200, maxMarkAgeSeconds: 60, minBlocksBetweenTrades: 0,
    maxOrderNotional: e18(1_000), maxPositionNotional: e18(200),
    maxTotalNotional: e18(1_000), maxBlockNotional: e18(1_000),
    volWindowSeconds: 0, stressHorizonSeconds: 0, stressSigmasX10: 0
  };
  const trade = {
    allowedMarkets: 1, direction: 0, maxPriceDeviationBps: 0,
    maxTradesPerDay: 0, maxDailyLossBps: 0, maxHoldingSeconds: 0
  };
  const fees = { performanceFeeBps: 0, managementFeeBps: 0 };
  // New exposure is also refused while Perpl's mark sits more than 1% from Perpl's
  // oracle price, or that price is older than 60 seconds.
  const reference = { maxMarkDeviationBps: 100, maxReferenceAgeSeconds: 60 };
  const receipt = await send("factory.createMandateWithReference", factory.createMandateWithReference({
    agent: wallet.address, adapter: adapter.target, limits, trade, fees,
    modelHash: keccak256(toUtf8Bytes("mandate perpl testnet"))
  }, reference));
  const created = receipt.logs
    .map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "MandateCreated");

  const deployment = {
    chainId: chainId.toString(),
    deployer: wallet.address,
    perpl: { exchange: EXCHANGE, collateral: AUSD, perpIds: PERP_IDS },
    MandateRiskGuard: guard.target,
    MandateRegistry: registry.target,
    PerplAdapter: adapter.target,
    MandateFactory: factory.target,
    vault: created.args.vault,
    termsHash: created.args.termsHash,
    venueLeverageHdths: VENUE_LEVERAGE_HDTHS,
    maxAdverseLimitBps: MAX_ADVERSE_LIMIT_BPS
  };
  fs.mkdirSync(path.dirname(PERPL_DEPLOYMENTS), { recursive: true });
  fs.writeFileSync(PERPL_DEPLOYMENTS, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Vault ${created.args.vault}, terms ${created.args.termsHash}`);
  console.log(`Wrote ${path.relative(root, PERPL_DEPLOYMENTS)}`);
}

if (step === "smoke") {
  const d = JSON.parse(fs.readFileSync(PERPL_DEPLOYMENTS, "utf8"));
  const vault = new Contract(d.vault, loadAbi("MandateVault.sol", "MandateVault"), signer);
  const adapter = new Contract(d.PerplAdapter, loadAbi("perpl/PerplAdapter.sol", "PerplAdapter"), provider);
  const amount = usd(SMOKE_AUSD);
  const held = await ausd.balanceOf(wallet.address);
  if (held < amount) throw new Error(`Need ${SMOKE_AUSD} aUSD, wallet holds ${formatUnits(held, 6)}`);

  await send("aUSD.approve", ausd.connect(signer).approve(d.vault, amount));
  await send("vault.allocate", vault.allocate(amount, wallet.address));

  // Each order's limit is 1% past the mark on the costly side, inside the adapter's
  // 3% band. The adapter opens the vault's Perpl account on the first order.
  const order = async (label, sizeE18, buy) => {
    const [mark] = await adapter.marketPrice(0);
    const limit = buy ? (mark * 101n) / 100n : (mark * 99n) / 100n;
    console.log(`${label} at mark ${formatUnits(mark, 18)}, limit ${formatUnits(limit, 18)}`);
    // The node's estimate can fall short: on testnet the first close ran out of gas
    // inside Perpl's exchange. Half again as much gas is enough.
    const args = [d.PerplAdapter, coder.encode(["int256", "uint256"], [sizeE18, limit])];
    const gasLimit = ((await vault.execute.estimateGas(...args)) * 3n) / 2n;
    await send(label, vault.execute(...args, { gasLimit }));
  };
  await order("open 0.001 BTC long", e18("0.001"), true);
  const [notional] = await adapter.positionState(d.vault);
  const [equity] = await adapter.markEquity(d.vault);
  console.log(`  position $${formatUnits(notional, 18)}, vault equity ${formatUnits(equity, 6)} aUSD`);
  await order("close it", -e18("0.001"), false);

  const shares = await vault.balanceOf(wallet.address);
  const before = await ausd.balanceOf(wallet.address);
  await send("vault.withdraw", vault.withdraw(shares, wallet.address));
  const back = (await ausd.balanceOf(wallet.address)) - before;
  console.log(`Allocated ${SMOKE_AUSD} aUSD, withdrew ${formatUnits(back, 6)} aUSD`);
}

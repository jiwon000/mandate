// Deploys the four-mandate demo book to a live RPC from the demo mnemonic.
//
//   MONAD_RPC_URL=... DEMO_MNEMONIC="..." npm run deploy:demo
//
// Account 0 of the mnemonic pays for everything and must hold MON already (the
// full deploy plus seeding is about 13.5M gas, 1.4 MON at Monad's 100 gwei
// floor, plus the gas allowance sent to each demo account). The result lands in
// web/deployments/<chainId>.json, which `npm run web:live` boots from.
import { JsonRpcProvider, NonceManager, formatEther, parseEther } from "ethers";
import { demoWallets } from "../../web/accounts.mjs";
import { GAS_PER_ACCOUNT_MON, deployLiveSystem, deploymentFileFor, networkInfo } from "../../web/live.mjs";

const {
  MONAD_RPC_URL,
  DEMO_MNEMONIC,
  DEMO_GAS_PER_ACCOUNT_MON = String(GAS_PER_ACCOUNT_MON),
  DEPLOYMENT_FILE = ""
} = process.env;
if (!MONAD_RPC_URL || !DEMO_MNEMONIC) throw new Error("Set MONAD_RPC_URL and DEMO_MNEMONIC");

const provider = new JsonRpcProvider(MONAD_RPC_URL);
provider.pollingInterval = 500;
const chainId = Number((await provider.getNetwork()).chainId);
const wallets = demoWallets(DEMO_MNEMONIC, provider);
const signers = {
  owner: new NonceManager(wallets.owner),
  allocator: new NonceManager(wallets.allocator),
  agents: wallets.agents.map((w) => new NonceManager(w)),
  keeper: new NonceManager(wallets.keeper)
};

const balance = await provider.getBalance(wallets.owner.address);
const needed = parseEther("1.6") + parseEther(DEMO_GAS_PER_ACCOUNT_MON) * 6n;
console.log(`Deploying from ${wallets.owner.address} to chain ${chainId} (${networkInfo(chainId).label}); balance ${formatEther(balance)} MON`);
if (balance < needed) {
  throw new Error(`Owner holds ${formatEther(balance)} MON; about ${formatEther(needed)} is needed for the deploy and the demo accounts' gas`);
}

const file = DEPLOYMENT_FILE || deploymentFileFor(chainId);
const stored = await deployLiveSystem({
  provider, wallets, signers, file,
  perAccountMon: Number(DEMO_GAS_PER_ACCOUNT_MON),
  log: (line) => console.log(line)
});

const explorer = stored.network.explorer;
const link = (address) => (explorer ? `[${address}](${explorer}/address/${address})` : `\`${address}\``);
console.log(`\nDone. Owner balance now ${formatEther(await provider.getBalance(wallets.owner.address))} MON.\n`);
console.log("| Contract | Address |");
console.log("| --- | --- |");
for (const [key, address] of Object.entries(stored.addresses)) console.log(`| ${key} | ${link(address)} |`);
for (const vault of stored.vaults) console.log(`| vault ${vault.name} | ${link(vault.address)} |`);

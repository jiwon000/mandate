// Prints the claim proofs of a settled BatchAllocator epoch as JSON, rebuilt from the
// settleEpoch() calldata, for when the demo server restarted and dropped them.
// Read-only and keyless: claimShares is permissionless, so anyone can relay a claim.
//
// Usage: MONAD_RPC_URL=... npm run claims:recover -- <batch address> <settle tx hash | epoch>
//   (RPC_URL works in place of MONAD_RPC_URL)
import { JsonRpcProvider } from "ethers";
import { recoverClaims } from "../tools/batch.mjs";

const rpc = process.env.MONAD_RPC_URL || process.env.RPC_URL;
const [batch, target] = process.argv.slice(2);
if (!rpc || !batch || !target) {
  throw new Error("Usage: MONAD_RPC_URL=... npm run claims:recover -- <batch address> <settle tx hash | epoch>");
}

const provider = new JsonRpcProvider(rpc);
const claims = await recoverClaims(provider, batch, /^\d+$/.test(target) ? BigInt(target) : target);
console.log(JSON.stringify(claims, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
provider.destroy();

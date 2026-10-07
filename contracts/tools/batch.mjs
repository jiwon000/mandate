import { Contract, Interface, TypedDataEncoder, concat, getAddress, keccak256, toBeHex } from "ethers";
import { getLogsChunked } from "./track-record.mjs";

export const intentTypes = {
  AllocationIntent: [
    { name: "allocator", type: "address" },
    { name: "vault", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minShares", type: "uint256" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function intentDomain(chainId, verifyingContract) {
  return { name: "MandateBatchAllocator", version: "1", chainId, verifyingContract };
}

export function hashIntent(domain, intent) {
  return TypedDataEncoder.hash(domain, intentTypes, intent);
}

const pairHash = (a, b) => keccak256(concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));

// Same ordered leaves, sorted pairs and odd-node promotion as BatchAllocator.
// Settlement order is vault address ascending, then the supplied intent order.
export function buildIntentTree(domain, intents) {
  if (intents.length === 0) throw new Error("An intent tree cannot be empty");
  const layers = [intents.map((intent) => keccak256(hashIntent(domain, intent)))];
  while (layers.at(-1).length > 1) {
    const level = layers.at(-1);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? pairHash(level[i], level[i + 1]) : level[i]);
    }
    layers.push(next);
  }
  return {
    root: layers.at(-1)[0],
    proofs: intents.map((_, index) => {
      const proof = [];
      for (let level = 0; level < layers.length - 1; level++) {
        const sibling = index ^ 1;
        if (sibling < layers[level].length) proof.push(layers[level][sibling]);
        index = Math.floor(index / 2);
      }
      return proof;
    }),
  };
}

const intentTuple = "tuple(address allocator, address vault, uint256 amount, uint256 minShares, uint256 epoch, uint256 nonce, uint256 deadline)";
const batchInterface = new Interface([
  `function settleEpoch(uint256 epoch, bytes32 intentRoot, tuple(address vault, tuple(${intentTuple} intent, bytes signature)[] intents)[] nets)`,
  "function claimableShares(bytes32 intentHash) view returns (uint256)",
  "function epochEnd(uint256 epoch) view returns (uint256)",
  "function settlementDeadline(uint256 epoch) view returns (uint256)",
  "event EpochSettled(uint256 indexed epoch, bytes32 intentRoot, uint256 intentCount)",
]);
const settledTopic = batchInterface.getEvent("EpochSettled").topicHash;

// The first block at or after `time` (unix seconds), or latest + 1 if none yet.
// Timestamps never decrease, so a binary search over [0, latest].
async function firstBlockAt(provider, time, latest) {
  let lo = 0;
  let hi = latest + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (BigInt((await provider.getBlock(mid)).timestamp) >= time) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Rebuilds the claim proofs of a settled epoch from its settleEpoch() calldata, which
// is all a restart of the demo server loses. Read-only: claimShares is permissionless
// and pays the signed allocator, so anyone can relay the result.
// `settle` is a transaction hash, or an epoch number (number/bigint). An epoch can
// only settle between its epochEnd and settlementDeadline, so its EpochSettled log is
// looked for in the blocks of that window alone, found by timestamp: Monad testnet
// refuses an eth_getLogs range wider than 100 blocks.
// Throws if the calldata does not rebuild the settled root.
// A claimed intent keeps its proof; `claimed` only says it has nothing left to claim.
export async function recoverClaims(provider, batchAddress, settle, { chunk = 100 } = {}) {
  const batch = getAddress(batchAddress);
  let hash = settle;
  if (typeof settle === "number" || typeof settle === "bigint") {
    const epoch = BigInt(settle);
    const windowed = new Contract(batch, batchInterface, provider);
    const [opens, closes] = await Promise.all([windowed.epochEnd(epoch), windowed.settlementDeadline(epoch)]);
    const latest = await provider.getBlockNumber();
    const from = await firstBlockAt(provider, opens, latest);
    const to = Math.min(latest, (await firstBlockAt(provider, closes + 1n, latest)) - 1);
    const logs = from > to ? [] : await getLogsChunked(provider, {
      address: batch, topics: [settledTopic, toBeHex(epoch, 32)],
    }, from, to, chunk);
    if (logs.length !== 1) throw new Error(`Expected one EpochSettled log for epoch ${settle}, found ${logs.length}`);
    hash = logs[0].transactionHash;
  }
  const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (!tx || !receipt) throw new Error(`Transaction ${hash} not found`);
  if (receipt.status !== 1) throw new Error(`Transaction ${hash} reverted`);
  if (!tx.to || getAddress(tx.to) !== batch) throw new Error(`Transaction ${hash} was not sent to ${batch}`);
  let decoded;
  try {
    decoded = batchInterface.decodeFunctionData("settleEpoch", tx.data);
  } catch {
    throw new Error(`Transaction ${hash} is not a settleEpoch call`);
  }
  const [epoch, root, nets] = decoded;
  const events = receipt.logs
    .filter((log) => getAddress(log.address) === batch && log.topics[0] === settledTopic)
    .map((log) => batchInterface.parseLog(log).args);
  if (events.length !== 1 || events[0].epoch !== epoch || events[0].intentRoot !== root) {
    throw new Error(`Transaction ${hash} did not settle epoch ${epoch} with the calldata root`);
  }
  const intents = nets.flatMap((net) => net.intents.map(({ intent: i }) => ({
    allocator: i.allocator, vault: i.vault, amount: i.amount, minShares: i.minShares,
    epoch: i.epoch, nonce: i.nonce, deadline: i.deadline,
  })));
  const { chainId } = await provider.getNetwork();
  const domain = intentDomain(chainId, batch);
  const tree = buildIntentTree(domain, intents);
  if (tree.root !== root) throw new Error(`Rebuilt root ${tree.root} does not match settled root ${root}`);
  const contract = new Contract(batch, batchInterface, provider);
  return Promise.all(intents.map(async (intent, index) => ({
    intent,
    proof: tree.proofs[index],
    claimed: (await contract.claimableShares(hashIntent(domain, intent))) === 0n,
  })));
}

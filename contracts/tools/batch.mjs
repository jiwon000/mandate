import { TypedDataEncoder, concat, keccak256 } from "ethers";

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

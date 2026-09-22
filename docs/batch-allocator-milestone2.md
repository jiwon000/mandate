# BatchAllocator — milestone 2

This milestone adds deposit-only batch allocation to the existing mock core. Registry, Reporter, fee accounting and a published Monad deployment remain pending. Update 2026-09-22: marked-NAV share pricing and the `poke()` drawdown freeze landed after this note was written; statements below that changed carry an update.

## Authorization and escrow

`BatchAllocator(asset, batcher, epochDuration, settlementWindow)` fixes the token, batcher and schedule at deployment. The deployer manages the supported-vault allowlist but has no escrow withdrawal, share withdrawal, arbitrary call or sweep function. Use only reviewed, non-upgradeable Mandate vaults with the same asset. A signature binds the exact vault address; allowlisting a new vault does not authorize spending into it.

Users call `depositEscrow(assets)` and sign EIP-712 `AllocationIntent` values off-chain. Domain: `MandateBatchAllocator`, version `1`, current chain ID, and the batch contract address. This milestone supports EOA signatures through OpenZeppelin ECDSA; ERC-1271 smart-wallet signatures are not implemented. All amounts and minimum shares use token/share base units; mUSDC has six decimals.

Nonces are allocator-scoped across every epoch and vault. Settlement consumes them; `cancelIntent(nonce)` permanently invalidates them. Multiple outstanding signatures must use different nonces unless the user deliberately wants mutually exclusive alternatives.

Unspent escrow is **always withdrawable** using `withdrawEscrow(assets)`, including after cancellation, intent expiry, settlement timeout or batcher censorship. This is a stronger availability rule than waiting for a timeout: signing does not reserve funds. If a user withdraws and later deposits again, an unexpired, uncancelled signature may still spend those new funds within its settlement window. Cancel its nonce to revoke that authorization. Cancellation/withdrawal and settlement are ordered by on-chain transaction execution; pending revocations are not effective yet.

The asset must be standard, non-rebasing USDC. Deposits reject a received balance different from the requested amount. This is not a general arbitrary-token integration.

## Epoch settlement

Epoch 0 starts at the deployment timestamp. For epoch `e`:

```
end      = genesis + (e + 1) * epochDuration
deadline = end + settlementWindow
```

Settlement is accepted at timestamps in the inclusive interval `[end, deadline]`. Each signed intent must also be unexpired. An epoch can settle at most once; missing an earlier epoch does not block later epochs. Omitted intents remain unspent and their escrow is refundable. This implementation nets deposits only, not signed withdrawal or rebalance intents. A vault whose `allocate` reverts (stale mark, `Frozen`) reverts the whole epoch, so the batcher must leave it out of the batch.

`settleEpoch(epoch, intentRoot, nets)` accepts vault groups strictly sorted by ascending numeric address, each containing signed intents. A transaction supports at most 128 intents. The limit is a validation bound, not a benchmarked Monad gas guarantee; use small batches until measured. The contract verifies all signatures, amounts, nonces, escrow balances, epochs and deadlines, and performs exactly one `allocate` call per vault. A failure in any group rolls back every debit, nonce, vault deposit and approval.

The contract grants only the exact deposit allowance and resets it to zero. It checks the actual token debit and share balance increase against the vault's returned result. Vault implementations and their risk configuration remain trusted integration boundaries.

The batcher cannot choose arbitrary user entitlements. For each vault, with total assets `A`, minted shares `S` and cumulative intent amount `C_i`, entitlement `i` is:

```
floor(C_i * S / A) - floor(C_(i-1) * S / A)
```

This assigns all `S` shares, including rounding remainder. Ordering can change an entitlement by a share base unit relative to its exact pro-rata value. Each entitlement must be nonzero and satisfy the signed `minShares`; otherwise the entire settlement reverts. Clients should calculate meaningful minimums rather than defaulting to zero.

## Root and claims

`contracts/tools/batch.mjs` exports the EIP-712 types/domain and matching root/proof builder:

1. Flatten intents in settlement calldata order.
2. Leaf = `keccak256(EIP712_digest(intent))` (a second hash prevents leaf/internal-node ambiguity).
3. Hash each pair in ascending bytes32 order; promote an odd final node unchanged.
4. Repeat to get the root. Single-intent trees have an empty proof.

Settlement recomputes this root. A root alone never grants spending rights. Changing the supplied root or any signed field reverts. Successful roots cannot be replaced.

The v0.2 sketch `claimShares(epoch, proof)` does not identify which of a user's potentially multiple vault/nonce entitlements is being claimed. The concrete ABI is therefore `claimShares(AllocationIntent intent, bytes32[] proof)`. The contract verifies membership and transfers the stored share entitlement to **intent.allocator**, regardless of the caller. Claims have no expiry and do not depend on the batcher or the current allowlist. Each entitlement can be claimed only once.

`MandateVault.transferShares(receiver, shares)` transfers only the caller's own shares. It introduces no approval mechanism or ability to spend another account's shares. It has no active-state gate, so a frozen vault still honours claims and withdrawals.

Proofs can be rebuilt from public settlement calldata, without a batcher-hosted proof API. The helper is a library for future API/UI integration; a chain indexer and automatic proof-retrieval service are not included here.

## Privacy boundary and specification decision

**This implementation reveals included intents and signatures in settlement calldata.** They are private only before submission to the chain (including the public mempool). Net vault deposits do not obscure that revealed allocator-to-vault association. Public evidence also cannot be deleted by a later Reporter retention policy.

The v0.2 documents contain both a pre-settlement privacy boundary and a stronger statement that raw intents are never placed on-chain. This milestone implements the former and does **not** satisfy the latter. A root plus aggregate amounts alone cannot prove users authorized escrow spending. Keeping included intents private after settlement would require an additional design, such as a zero-knowledge authorization/conservation proof with a compatible claim/funding scheme, or a different trust assumption. That is not implemented or claimed here. Future UI/README copy must not imply full linkage privacy from this batcher.

No DP release is implemented by this contract. DP budget accounting and eventual publication must independently account for the public settlement side channel.

## Validation and remaining work

Run `npm ci`, `npm run compile`, and `npm run test:contracts` with Node 22.14+; `solc` is pinned to 0.8.37 (EVM `prague`) and OpenZeppelin Contracts to 5.4.0. After dependencies are installed, compile and tests use the local compiler and an in-process Hardhat 3 (EDR) chain without RPC or remote compiler downloads.

Dependency remediation and an audit of exploitability are not part of this milestone; no blanket `npm audit fix --force` has been applied.

Tests exercise multi-user/multi-vault deposits, odd-leaf proofs, one net deposit per vault, claim relay, duplicate claims, root immutability, signature field/domain tampering, duplicate nonces, cancellation, deadlines, insufficient escrow, minimum shares, cross-vault rollback and rounding conservation. They are integration/regression tests, not a completed security audit or Foundry fuzz campaign.

Update 2026-09-22: the adapter now marks vault equity (cash plus unrealised PnL) to the venue price, shares are priced at that mark, and a drawdown breach freezes the vault through `poke()`. The mock venue still does not liquidate positions or charge funding, and fee terms are not implemented. Do not interpret the passing deposit/trade/withdrawal demo as production derivatives accounting. Those boundaries must be resolved before any real-money use.

`deploy:monad` now deploys `BatchAllocator` alongside the core, allowlists the vault and writes the addresses to `contracts/deployments.latest.json`. No Monad testnet addresses have been published yet; execution-state confirmation and address publication remain separate work.

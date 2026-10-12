# Mandate technical specification

This document describes the contracts, the reporter and the demo as they are in this repository. It replaces `mandate-technical-spec-v0.2.md`, which was written before most of the code and had drifted from it. Section numbers 1 to 9 and the numbering of the core invariants in section 6 are the same as in v0.2, so a reference such as "spec 4.3" or "core invariant #8" in a source comment still points to the right place.

Where this document and the code disagree, the code is right and this document has a bug. Constants are quoted with their names so they can be searched for in `contracts/src/`.

Related documents: the root [README](../README.md) (status, limitations, suggested ranges for each term), [`perpl-adapter.md`](perpl-adapter.md), [`batch-allocator-milestone2.md`](batch-allocator-milestone2.md), [`mandate-lifecycle-design.md`](mandate-lifecycle-design.md), [`threat-model.md`](threat-model.md) and [`security-review-2026-10-04.md`](security-review-2026-10-04.md).

## 1. Product definition

Mandate is a capital-allocation market for autonomous trading agents. An allocator deposits into a vault; an agent trades the vault's capital through one venue adapter; a risk guard checks every order against terms that were locked before the first deposit.

Three properties define the product:

1. **No custody for the agent.** The agent's only right is `MandateVault.execute()`. It cannot withdraw, transfer or approve the vault's assets.
2. **Terms enforced on-chain.** An order outside the mandate reverts before it reaches the venue. A vault whose marked value falls past its drawdown term is frozen by anyone who calls `poke()`, and anyone can then close its position with `unwind()`.
3. **Withdrawal nobody can revoke.** `withdraw()` is open in every vault state. No agent, operator or freeze can block it; only a venue price that is too old to trust can delay it, and section 3.2 describes the exit that remains even then.

Differential privacy (section 4) is applied to published performance statistics. It is not a fund-safety mechanism and it does not hide anything that is already public on-chain.

The security claim, stated once and used unchanged elsewhere:

> Custody and execution permissions are enforced on-chain. Market-value risk limits depend on the configured venue price source; the demo uses a deterministic on-chain mock venue.

## 2. System architecture

```text
Operator ─ MandateFactory.createMandate() ─┬─ deploys MandateVault
                                           ├─ sets and locks terms on MandateRiskGuard
                                           └─ lists the vault on MandateRegistry

Allocator ─ allocate() / withdraw() ───────────────────────────► MandateVault
Allocator ─ signed intent ─ batcher ─ BatchAllocator.settleEpoch() ─► MandateVault (one net deposit)

Agent ─ execute(order) ─► MandateVault ─► IVenueAdapter.preview()
                               │            MandateRiskGuard.checkAndConsumeBefore()
                               │            IVenueAdapter.execute() ─► venue
                               │            MandateRiskGuard.checkAfter()
                               │
                               ├─ MockVenueAdapter ─► DeterministicMockVenue   (hosted demo)
                               └─ PerplAdapter ─► PerplSubaccount ─► Perpl     (testnet)

Anyone ─ poke() / freezeUnobservable() / resume() ─► MandateRiskGuard ─► MandateVault.freeze() / resume()
Anyone ─ unwind() / deleverageForRedemption() ────► MandateVault ─► IVenueAdapter.reduce()

reporter/ (off-chain) ─ signed release ─► MandateRegistry.postLeaderboard()
```

### Trust boundaries

| Party | Can | Cannot |
| --- | --- | --- |
| Agent | Send orders through the vault's one adapter, inside the locked terms | Move, approve or withdraw assets; change terms; trade through another adapter |
| Operator (whoever calls the factory) | Choose the agent, a listed adapter and the terms, once | Change anything after `lockTerms()`; the factory locks in the creating transaction |
| Factory owner | List and unlist adapters for future vaults | Touch an existing vault or its terms |
| Guard owner | Configure vaults that are not yet locked | Change locked terms; freeze or resume outside the public rules |
| Batcher (one address, immutable) | Choose which signed intents an epoch settles; delay or leave out an intent | Take escrow, change an intent's amount, vault or recipient, or stop `withdrawEscrow()` |
| Reporter (one signing key) | Publish noised statistics and spend the ε budget | Move funds; exceed the on-chain ε cap; rewrite a posted release |
| Venue price source | Decide the mark every market-value check uses | — this is trusted. A wrong mark that stays inside the terms prices shares and drawdown wrongly |
| Anyone | Freeze a vault that is past its terms, unwind a frozen vault, feed marks, record outcomes | Freeze a vault that is inside its terms |

The hosted demo runs on the mock venue with mock USDC, and the mock venue's price is posted by the team's keeper. `PerplAdapter` marks at Perpl's own on-chain mark instead; it has been exercised on Monad testnet only with small trades (see `perpl-adapter.md`).

## 3. On-chain components

Solidity 0.8.37, OpenZeppelin 5.4. Sources are in `contracts/src/`; the shared types and interfaces are in `interfaces/IMandate.sol`.

### 3.1 Common types

```solidity
struct RiskLimits {
    uint16  maxLeverageX100;        // 300 = 3x, total notional / marked equity
    uint16  maxDrawdownBps;         // NAV per share below its high-water mark; (0, 5000]
    uint32  minBlocksBetweenTrades;
    uint32  maxMarkAgeSeconds;      // (0, 60]
    uint256 maxOrderNotional;
    uint256 maxPositionNotional;
    uint256 maxTotalNotional;
    uint256 maxBlockNotional;
    uint32  volWindowSeconds;       // 0 disables the volatility clause
    uint32  stressHorizonSeconds;
    uint16  stressSigmasX10;        // 30 = 3 sigma
}

struct TradeTerms {
    uint32 allowedMarkets;          // bitmask of venue market ids, must be non-zero
    uint8  direction;               // 0 both, 1 long only, 2 short only
    uint16 maxPriceDeviationBps;    // limit price vs mark
    uint16 maxTradesPerDay;         // exposure-adding trades per UTC day
    uint16 maxDailyLossBps;         // fall of NAV per share within one UTC day
    uint32 maxHoldingSeconds;       // time a position may stay open
}

struct ReferenceTerms {             // optional
    uint16 maxMarkDeviationBps;     // venue mark vs the adapter's reference price
    uint32 maxReferenceAgeSeconds;  // (0, 60] when set
}

struct FeeTerms {
    uint16 performanceFeeBps;       // at most 3000
    uint16 managementFeeBps;        // at most 500 a year
}
```

Notionals are in 1e18 USD; prices are 1e18; the asset is a 6-decimal token. A zero turns a `TradeTerms` field off, except `allowedMarkets`. The three volatility fields were appended to `RiskLimits` so that hashes of older limits are not re-ordered.

`TradePreview` is what an adapter returns for an order before it is sent:

```solidity
struct TradePreview {
    uint256 orderNotional;
    uint256 expectedPositionNotional;
    uint256 expectedTotalNotional;
    uint256 expectedLeverageX100;
    uint256 minAmountOut;
    bytes32 orderHash;
    uint256 marketId;
    int256  resultingSizeE18;
    uint256 limitPriceE18;
    uint256 markPriceE18;
    int256  currentSizeE18;
}
```

**Terms hash.** `MandateRiskGuard.termsHash(vault)` is `keccak256(abi.encode(limits, tradeTerms, fees))`. A vault with reference terms hashes `(limits, tradeTerms, fees, referenceTerms)`, and a vault with an unwind bounty floor hashes `(limits, tradeTerms, fees, referenceTerms, floor)`. A vault with neither hashes exactly as it did before those terms existed.

**Vault states.** `Active` (0), `Frozen` (1), `Closed` (2). The state never moves backwards except `Frozen → Active` through `resume()` for one freeze reason (section 3.4). `Closed` is terminal.

### 3.2 MandateVault

One vault holds one asset, has one agent, one risk guard and one venue adapter, all immutable. `execute()` reverts with `AdapterMismatch` for any other adapter.

**Share accounting.** `totalAssets()` is the vault's cash balance. `markedAssets()` is `venueAdapter.markEquity(vault)`: cash plus the value of the open position at the venue mark, with the venue's own timestamp for that mark. Shares are priced on marked equity.

| Function | Who | State | Behaviour |
| --- | --- | --- | --- |
| `allocate(assets, receiver)` | anyone | Active | Reverts `TermsNotLocked` until the guard has locked the vault's terms. The first deposit mints `assets − MIN_SHARES` and locks `MIN_SHARES` (1e3) to `0xdead`. Later deposits need a fresh mark and mint `assets × supply / equity` |
| `withdraw(shares, receiver)` | share holder | any | Pays at marked NAV out of cash. If the claim is larger than the cash, it pays the cash and burns only the shares that cash bought. Needs a fresh mark except in `Closed`, where a venue that cannot be read counts as no mark and cash prices the share |
| `withdrawUnpriced(shares, receiver, minAssets)` | share holder | Frozen, mark not fresh | Pays the pro-rata share of cash, capped at the shares' value at the guard's last mark. The holder's part of the open position stays with the remaining holders |
| `transferShares(receiver, shares)` | share holder | any | No approvals exist. Shares under a redeem request cannot move |
| `execute(adapter, order)` | agent | Active | See "Execution" below |
| `requestRedeem(shares)`, `cancelRedeem()` | share holder | Active | Starts or cancels a redemption notice |
| `deleverageForRedemption(allocator)` | anyone | Active | See "Redemption queue" below |
| `accrueFees()` | anyone | any | Mints due fees; a no-op unless Active and on a fresh mark |
| `freeze(beneficiary)`, `resume()` | risk guard only | — | See section 3.4 |
| `unwind()` | anyone | Frozen | See section 3.4 |

**Execution.** `execute()` runs, in one transaction:

1. accrue fees;
2. `adapter.preview(vault, order)`;
3. if a redemption deleverage happened less than `REDEEM_GRACE` (1 hour) ago, refuse an order that adds risk (`RedemptionDeleveraging`);
4. `riskGuard.checkAndConsumeBefore(vault, adapter, preview)`;
5. approve the adapter for the vault's cash, call `adapter.execute(vault, order)`, set the approval back to zero;
6. read `adapter.positionState(vault)` and revert with `ResultMismatch` unless position and total notional equal what the preview said;
7. `riskGuard.checkAfter(vault, adapter)`.

A revert at any step undoes all of them, so an order is either fully checked and filled as previewed or has no effect.

**Fees.** Both fees are paid by minting shares to the agent; no cash moves. The management fee is `equity × managementFeeBps × elapsed / (10000 × 365 days)` and accrues only while the vault is `Active`. The performance fee is `performanceFeeBps` of the gain in NAV per share above `feeHighWaterNavPerShare`, which starts at 1e18. Fees are minted only on a fresh mark, accrual stops at a freeze, and after a mint the guard rescales its own high-water marks by `supplyBefore / supplyAfter` (`onFeeMint`) so that a fee is not read as a drawdown.

**Redemption queue.** A withdrawal is limited by cash. An allocator whose claim is larger than the cash calls `requestRedeem(shares)`. After `REDEEM_NOTICE` (1 day), anyone can call `deleverageForRedemption(allocator)` while the vault is `Active` and its cash is below the marked claim. The call closes

```text
fractionBps = ceil((claim − cash) × (10000 + DELEVERAGE_BUFFER_BPS) / (equity − cash)), capped at 10000
```

of the position through `adapter.reduce()` (`DELEVERAGE_BUFFER_BPS` = 500), at most once per block. It pays no bounty, restarts the notice, and blocks risk-adding orders for `REDEEM_GRACE`. The freed cash goes to whoever withdraws first.

**Events.** `Allocated`, `Withdrawn`, `WithdrawnUnpriced`, `Executed`, `SharesTransferred`, `Frozen`, `Unwound`, `Closed`, `Resumed`, `RedeemRequested`, `RedeemCancelled`, `DeleveragedForRedemption`, `FeesAccrued`.

### 3.3 Venue adapters

Mandate does not allow arbitrary `(venue, selector)` calls. A venue is supported only through an adapter that implements `IVenueAdapter`:

| Function | Purpose |
| --- | --- |
| `preview(vault, order) → TradePreview` | Decode the order and state what it would leave, without changing anything |
| `execute(vault, order) → (realizedPnl, amountOut)` | Send the order. Vault only |
| `positionState(vault) → (positionNotional, totalNotional)` | What the vault holds now |
| `reduce(vault, fractionBps) → (closedNotional, realizedPnl)` | Close a fraction of every position, reduce-only. Vault only |
| `markEquity(vault) → (equity, markedAt)` | Cash plus position value at the venue mark; `markedAt` is the venue's price timestamp, never `block.timestamp` |
| `markPrice(vault)`, `marketPrice(marketId)` | The venue mark |

An adapter is acceptable when:

- the order calldata decodes completely, and an order it cannot decode reverts;
- the notional and the resulting position can be computed before the call;
- a fill that differs from the preview reverts the whole transaction;
- it never grants an approval to, or accepts a callback from, an address the vault did not name.

Both adapters decode the same order: `abi.encode(int256 sizeDeltaE18, uint256 limitPriceE18)` (64 bytes, market 0) or `abi.encode(uint256 marketId, int256 sizeDeltaE18, uint256 limitPriceE18)` (96 bytes). Any other length reverts with `BadOrder`. `positionNotional` is the largest single-market position and `totalNotional` is the gross sum over markets.

**MockVenueAdapter and DeterministicMockVenue.** The mock venue holds up to `MAX_MARKETS` (8) markets, each with a price and the timestamp of its last update. A trade fills at the current price exactly, provided the price is on the right side of the order's limit. The venue keeps a cost basis per vault and market and does not move tokens: profit and loss exist as `markValue − cost`, not as a settled balance. `markEquity()` is cash plus unrealised PnL over all markets, and `markedAt` is the oldest price timestamp among the markets the vault holds (market 0 when it is flat). `reduce()` closes the same fraction of every market at a limit `MAX_UNWIND_SLIPPAGE_BPS` (1%) from the mark. The mock venue does not liquidate, charge funding or model liquidity.

**PerplAdapter and PerplSubaccount.** Perpl keys accounts by `msg.sender` and holds margin per position, so the adapter deploys one `PerplSubaccount` per vault (CREATE2, salt = vault address) the first time the vault trades. `execute()` pulls the margin the order needs from the vault, places the order as fill-or-kill and immediate-or-cancel, and sends free collateral back to the vault. Between trades the vault's money is its cash plus the margin locked in open positions. A subaccount can send collateral only to the vault it was created for.

- Prices and timestamps are Perpl's own mark. Funding counts in equity as Perpl reports it.
- `maxAdverseLimitBps`, fixed when the adapter is deployed, bounds how far an order's limit may sit past Perpl's mark on the side that costs the vault (`LimitTooFarFromMark`). It stops an agent from resting a far-off order from another account and having the vault take it.
- `venueLeverageHdths` is the margin setting used on Perpl. It is not the mandate's leverage term, which the guard checks separately.
- Opening the account needs vault cash of at least Perpl's minimum (`BelowAccountMinimum`).
- `reduce()` uses reduce-only orders that may fill in part, at most 1% through the mark; a market Perpl refuses is retried once for the whole position and otherwise skipped.
- `sweep(vault)` is permissionless and returns free collateral to the vault.
- The adapter also implements `IReferencePriceSource`: `referencePrice(marketId)` is Perpl's oracle price and its timestamp, which the optional reference terms compare with the mark.

The adapter does not model Perpl's liquidation, and it cannot unwind while Perpl refuses orders. Details, addresses and the testnet runs are in `perpl-adapter.md`.

### 3.4 RiskGuard state transitions

`MandateRiskGuard` holds the terms of every vault configured on it and decides three things: whether an order may go through, whether a vault must freeze, and whether a frozen vault may resume.

**Refusal is not a freeze.** A transaction that reverts cannot also record a state change, so a refused order never freezes anything. Refusals and freezes are separate paths:

1. **Before a trade** (`checkAndConsumeBefore`): the order reverts and nothing else changes.
2. **After a trade** (`checkAfter`) and **between trades** (`poke`, `freezeUnobservable`): the guard re-marks the vault and may freeze it.

**Configuration and lock.** Terms are set by the guard's owner or, in practice, by the factory in the creating transaction (`configureTerms`, optionally `setReferenceTerms` and `setUnwindBountyFloor`, `setAdapter`). The guard refuses terms outside these ranges: `maxDrawdownBps` in (0, 5000], `maxMarkAgeSeconds` in (0, 60], `allowedMarkets` non-zero, `direction` ≤ 2, `maxPriceDeviationBps` ≤ 10000, `maxDailyLossBps` ≤ 5000, fees within `MAX_MANAGEMENT_FEE_BPS` (500) and `MAX_PERFORMANCE_FEE_BPS` (3000). A volatility clause needs a non-zero horizon and sigma count and exactly one allowed market. Reference terms need an adapter whose `referencePrice()` already answers for every allowed market (`NoReferencePrice`). `lockTerms(vault)` is one-way and emits `TermsLocked(vault, termsHash)`; after it every setter reverts. There is no amendment path: different terms mean a new vault.

**Which orders add risk.** An order adds risk when total notional after it is larger than before, or when it takes a position through flat to the other side. Every other order is reducing.

| Check | Applies to | Error |
| --- | --- | --- |
| `maxOrderNotional` | every order | order reverts |
| `maxPositionNotional`, `maxTotalNotional`, `maxLeverageX100` | risk-adding orders | order reverts |
| `allowedMarkets`, `direction`, `maxPriceDeviationBps` | every order; direction is checked on the position the order leaves, so a shrinking order always passes | `MarketNotAllowed`, `DirectionNotAllowed`, `PriceDeviationExceeded` |
| `maxTradesPerDay` | risk-adding orders, counted per UTC day | `DailyTradesExceeded` |
| Reference terms | risk-adding orders | `ReferenceTooOld`, `MarkDeviationExceeded` |
| `maxDailyLossBps` | risk-adding orders, until the next UTC day | `DailyLossPaused(resumesAt)` |
| Volatility clause | risk-adding orders | `StressBreach(sigmaBps, moveBps, stressedDrawdownBps)` |
| `minBlocksBetweenTrades` | every order | `CooldownActive` |
| `maxBlockNotional` | every order, summed per block | order reverts |
| `maxMarkAgeSeconds` | every order, allocation and withdrawal | `MarkTooOld` |

Reducing orders skip the position, total and leverage caps because a price move can carry a position past them and the agent must still be able to shrink it.

**Three tiers of consequence.**

1. *Pause.* A daily loss past `maxDailyLossBps` stops risk-adding orders until the next UTC day. Nothing freezes and the position stays with the agent.
2. *Resumable freeze.* If no mark newer than `UNOBSERVABLE_MARK_AGES` (3) × `maxMarkAgeSeconds` exists, or the venue cannot be read, anyone can call `freezeUnobservable(vault)` (reason 2). Unwinding is held off for `UNOBSERVABLE_RECOVERY` (15 minutes). Until the first unwind step, anyone can call `resume(vault)`, which succeeds only if a fresh mark holds every limit, measured from the same high-water mark (`StillBreached` otherwise). A second such freeze within `REFREEZE_BOUNTY_COOLDOWN` (1 day) of a resume still freezes but pays no bounty.
3. *Final freeze.* `poke(vault, adapter)` re-marks the vault and freezes it when the drawdown exceeds `maxDrawdownBps` (reason 1) or a position has been open longer than `maxHoldingSeconds` (reason 4). `checkAfter` applies the same drawdown test after every trade. These freezes cannot be resumed.

`freezeOf(vault)` returns the reason and time and keeps them after a resume. A freeze pays the caller `POKE_BOUNTY_BPS` (0.05%) of the vault's cash. A frozen vault refuses trades and deposits; withdrawals and share transfers stay open.

**Unwind.** A freeze stops the agent but leaves the position open. `MandateVault.unwind()` is permissionless, works only in `Frozen`, runs at most once per block and not before `riskGuard.unwindAllowedAt(vault)`. Its `UNWIND_STEPS` (5) steps ask the adapter to close 1/5, 1/4, 1/3, 1/2 and then all of what is left, reduce-only and inside the adapter's 1% slippage bound. A step that closed size pays the caller the larger of `UNWIND_BOUNTY_BPS` (0.01%) of cash and the vault's locked floor, never more than `UNWIND_BOUNTY_CAP_BPS` (0.2%) of cash. When no position is left the vault moves to `Closed`. Nothing executes `unwind()` automatically; the bounty is the incentive.

The drawdown term therefore reads: the agent stops at X% and liquidation can start; the realised loss can exceed X% by slippage and gaps.

**Volatility clause.** The guard keeps a variance rate per vault, built from the marks it sees (every trade, `poke()`, and the permissionless, unbountied `observe()`):

```text
v' = (window × v + r²) / (window + dt)        r = return since the previous mark, dt = seconds since it
sigmaBps            = sqrt(v × stressHorizonSeconds), in bps
moveBps             = sigmaBps × stressSigmasX10 / 10
lossBps             = leverageX100 × moveBps / 100
```

A risk-adding order is refused when a loss of `lossBps` from the current NAV would leave the vault more than `maxDrawdownBps` below its high-water mark. A first mark only seeds the series and a mark the guard has already seen changes nothing. No external volatility source is used.

**Views.** `quote`, `stressQuote`, `dailyLossQuote`, `referenceQuote`, `limitsOf`, `tradeTermsOf`, `feesOf`, `referenceTermsOf`, `unwindBountyFloorOf`, `markOf`, `volOf`, `dayOf`, `tradesOf`, `freezeOf`, `termsHash`, `termsLocked`, `adapterAllowed`.

### 3.5 Price and drawdown

- **Mark.** The venue's price for a market and the time the venue last set it. The guard never substitutes `block.timestamp`, so a chain that produces blocks quickly cannot make an old price look fresh.
- **Fresh.** A mark is fresh when `block.timestamp − markedAt ≤ maxMarkAgeSeconds`. A price's timestamp can advance at most once per block, so a mark-age term shorter than the chain's block interval cannot be honoured. This is the reason Mandate targets a chain with short blocks: the term an allocator can ask for is bounded below by the block interval.
- **NAV per share.** `markedAssets × 1e18 / totalSupply`.
- **High-water mark.** The highest NAV per share the guard has seen for the vault, starting at 1e18 and rescaled when fee shares are minted.
- **Drawdown.** `(highWater − nav) × 10000 / highWater`, in bps. It is mark-to-market: it includes unrealised PnL.
- **Leverage.** Total notional divided by marked equity, checked when an order is placed and not afterwards.
- **Daily NAV.** For the daily-loss term the guard keeps, per UTC day, the last NAV marked before the day began and the last NAV seen.

On the mock venue the mark's timestamp is the block in which the keeper last pushed the price, so freshness there shows that the keeper is alive, not that the price is right. A production deployment needs a price the operator does not control.

### 3.6 BatchAllocator

Deposit-only epoch netting for a standard, non-rebasing token. Signed intents become public at settlement; there is no anonymity guarantee.

```solidity
struct AllocationIntent {
    address allocator; address vault; uint256 amount; uint256 minShares;
    uint256 epoch; uint256 nonce; uint256 deadline;
}
```

Flow:

1. The allocator calls `depositEscrow(assets)`. A token that delivers less than it was sent is refused (`UnsupportedToken`).
2. The allocator signs an `AllocationIntent` (EIP-712, domain `MandateBatchAllocator` version `1`) off-chain and hands it to the batcher.
3. After `epochEnd(epoch) = genesis + (epoch + 1) × epochDuration` and before `settlementDeadline(epoch) = epochEnd + settlementWindow`, the batcher calls `settleEpoch(epoch, intentRoot, nets)` once. Vault groups must be strictly address-sorted and allowlisted, with at most `MAX_INTENTS` (128) intents in total. For each intent the contract checks the signature, epoch, vault, deadline, nonce and escrow. Each vault receives one net deposit. The Merkle root is recomputed from the verified intents (sorted pairs, an odd node is promoted) and must equal `intentRoot`; it is never trusted as authorisation.
4. A vault that refuses its deposit (frozen, mark too old) is skipped: `VaultSkipped` is emitted, the amounts return to escrow and the nonces stay spent.
5. `claimShares(intent, proof)` sends each allocator its pro-rata shares through `transferShares`. Anyone may relay a claim; the shares go to the signed allocator. `minShares` is enforced and claims do not expire.

`withdrawEscrow(assets)` returns unspent escrow at any time, and `cancelIntent(nonce)` invalidates a signed intent before it is settled.

Limits: the batcher is one address. It can leave an intent out or delay it, in which case the allocator withdraws and deposits directly. Escrow deposits, settled intents and their signatures are public, so netting reduces direct allocator-to-vault transactions but hides nothing after settlement. The ABI and the design decisions are in `batch-allocator-milestone2.md`.

### 3.7 MandateRegistry / DP anchor

The registry is a catalogue of vaults and the one place a reporter release is anchored.

**Catalogue.** Each vault can be registered once, forever.

- `registerFromFactory(vault, adapter, modelHash, operator)` — factory only. Fees and the terms hash are read from the guard, so the only values taken on the factory's word are `modelHash` and the operator's address.
- `registerAgent(vault, adapter, limits, fees, modelHash)` — for a vault created outside the factory. The guard is read from `vault.riskGuard()` and is not a parameter; the caller must be that guard's owner; the terms must be locked; the hash recomputed from the stated limits and fees, with the trade terms, reference terms and floor read from the guard, must equal `guard.termsHash(vault)` (`TermsMismatch`); the adapter must be on the vault's allowlist. Once a canonical guard is set, only vaults on it are accepted.
- `recordOutcome(vault)` — permissionless; copies the vault's state and the guard's freeze record into the registry, read from the chain so that no reporter is trusted for them.
- `linkVault(vault)` — the vault's agent lists the vault under its own address.

**Release anchor.**

```solidity
function postLeaderboard(
    uint256 epoch, uint256 pinnedBlock, bytes32 statsDigest,
    uint256 epsilonPerfE6, uint256 epsilonIntentE6, uint256 cumulativeEpsilonE6,
    bytes calldata reporterSig
) external;
```

Anyone may send the transaction; what is checked is the reporter's EIP-712 signature over `LeaderboardRelease(uint256 epoch,uint256 pinnedBlock,bytes32 statsDigest,uint256 epsilonPerfE6,uint256 epsilonIntentE6,uint256 cumulativeEpsilonE6)` in the domain `MandateRegistry` version `1`. The contract enforces:

- `epoch` and `pinnedBlock` strictly increase, and `pinnedBlock` is not in the future;
- `cumulativeEpsilonE6` equals the previous cumulative value plus `epsilonPerfE6 + epsilonIntentE6`;
- the cumulative value does not exceed `epsilonCap` (0 means no cap);
- a posted release cannot be replaced, because its epoch can never be used again.

`statsVersion` is not a separate on-chain field; it is inside `statsDigest`.

**Noise pledge.** `commitNoiseSeed(commitment)` lets the reporter record `keccak256(seed)` for its next release, one pending pledge per window. The next `postLeaderboard()` binds the pledge to its epoch (`noiseCommitOf(epoch)`: the commitment, the block it was made in and the block the window opened at). The seed itself is never posted (section 4.3).

**Owner.** `setReporter`, `setEpsilonCap`, and `setCanonicalGuard` and `setFactory`, each of which can be set only once.

What the chain does not check: that the statistics behind `statsDigest` are correct, or that noise was added. It checks who signed, the order of releases and the ε arithmetic.

### 3.8 MandateFactory

`createMandate(params)` deploys a vault, allows its adapter, sets its terms, locks them and registers the vault, in one transaction. Anyone can call it. `createMandateWithReference(params, referenceTerms)` and `createMandateWithFloor(params, referenceTerms, unwindBountyFloor)` add the optional terms.

```solidity
struct MandateParams {
    address agent; address adapter;
    RiskLimits limits; TradeTerms trade; FeeTerms fees;
    bytes32 modelHash;
}
```

The factory refuses: a zero agent; an adapter its owner has not listed; leverage outside (0, `MAX_LEVERAGE_X100` = 2000]; a cooldown above `MAX_COOLDOWN_BLOCKS` (100000); a zero notional; `maxOrderNotional > maxBlockNotional`; `maxPositionNotional > maxTotalNotional`. The guard's own range checks (section 3.4) apply on top. `listAdapter()` refuses an adapter whose `collateral()` is not the factory's asset.

The factory owner's only power is the adapter list. It emits `MandateCreated(vault, operator, agent, adapter, termsHash)`.

## 4. DP Reporter

`reporter/` is an off-chain module that turns per-vault returns into a noised, signed release. It never sends a transaction; the caller posts the release.

### 4.1 Scope of the guarantee

| Signal | Status |
| --- | --- |
| Performance leaderboard: mean return, Sharpe, marked max drawdown | Released with Laplace noise. Inputs are trade returns and NAV series that are already public on-chain |
| Batch settlement amounts | Public on-chain. Shown as analytics, not protected |
| Trades and vault state | Public on-chain |
| Private watchlists, pre-settlement allocation intents | Not built. The demo collects no such data, so `epsilonIntentE6` is always 0 |

Differential privacy here bounds what a published statistic adds to what an observer knows. It does not hide transactions, and since the inputs are public, an observer who reads the chain can compute the exact statistics without the release. The mechanism is in place for inputs that are not public; v1 has none.

### 4.2 Performance statistics

- Per-tick returns are clipped to `[−c, c]` (`clipBound`, default 0.1).
- The release contains the mean of the clipped returns, their Sharpe ratio (mean over sample standard deviation) and the marked maximum drawdown of the NAV series (peak to trough; a different quantity from the guard's live drawdown against its high-water mark).
- Noise is Laplace with `scale = 2c / (N × ε)`, the sensitivity of a mean of `N` clipped values.

That scale is derived from the mean's sensitivity and reused for all three numbers. **The stated ε is therefore an exact guarantee for the mean only.** The noised Sharpe and max-drawdown figures are indicative; their own sensitivities under clipping have not been derived. The unit protected is one per-tick return, so a vault that contributes `k` returns to a release is covered at `k × ε`. The noised max drawdown is clamped to [0, 1].

### 4.3 Budget, determinism and the noise pledge

**Digest.**

```text
statsDigest = keccak256(abi.encode(
    uint256 statsVersion, int256 noisyMeanE6, int256 noisySharpeE6,
    uint256 noisyMaxDrawdownE6, uint256 sampleSize))
```

**Budget.** `EpsilonLedger` mirrors the registry's accounting: `propose(epoch, perf, intent)` rejects an epoch that does not advance and a release that would pass the cap, without changing state; `commit(epoch, cumulative)` is called only after the transaction confirms. A release the reporter builds is therefore one the contract accepts. A changed `statsVersion` is a new release and spends ε again. Release cadence and ε per release are configuration of whoever runs the reporter.

**Seed.**

```text
seed = HMAC_SHA256(reporterSecret, domainSeparator | epochId | statsVersion)
```

Laplace samples are drawn from a SHA-256 counter stream keyed by the seed, so the same inputs always produce the same release. The seed depends on nothing the window's data teaches the reporter (no pinned block, no sample count), which is what allows it to be pledged before that data exists.

**Pledge.** Before a window's data exists the reporter posts `keccak256(seed)` with `commitNoiseSeed()`, and the release is bound to it. The seed is never published: whoever holds it can subtract the noise and read the exact aggregate. The pledge gives accountability, not public verification:

- anyone can run `node contracts/script/verify-noise.mjs` to see that a pledge was bound to a release, how early in the window it landed and, given the published numbers, that their digest is the one on chain;
- only an auditor the operator hands the seed to can check, with the same script's `--seed` mode, that the release used the pledged seed. That audit de-noises the release for the auditor.

### 4.4 Published ε vs Privacy Simulator

- **Published ε** is fixed for an epoch, spent by a real release and anchored by `postLeaderboard()`.
- **Privacy Simulator** (`reporter/simulator.mjs`) shows how ε changes the width of a confidence interval on synthetic data: `halfWidth = scale × ln(20)` for a 95% two-sided interval, with the same scale formula as a real release. It imports neither the ledger nor the reporter secret, so using it cannot produce a release or spend budget.

The UI labels the simulator as a synthetic preview and keeps it apart from the published leaderboard.

## 5. Demo agents

The protocol's claims rest on the vault and the guard, not on any agent. The agents in this repository exist to exercise the contracts:

- **Hosted demo.** The four mandates in `web/mandates.mjs` trade through orders sent from the UI: one inside the mandate, one past each term, and reduce-only orders. The keys are testnet keys held by the demo server.
- **Perpl testnet.** `contracts/script/perpl-agent.mjs` is a rule-based script that sends small orders through `PerplAdapter`, including orders past the position cap to show the refusal on chain. Its runs are recorded in `perpl-adapter.md`.

Neither is a trading strategy, neither uses a model, and no return is claimed for either.

## 6. Core invariants

1. The agent cannot withdraw, transfer or approve the assets of an allocator or a vault.
2. No external call is made through an adapter other than the one the vault was built with and the guard allows.
3. Order, block, position and total notional limits are checked before the external trade.
4. If the adapter's result differs from its preview, the whole transaction reverts.
5. After a freeze, `execute` and `allocate` are blocked and `withdraw` stays open. `unwind()` works only in `Frozen` and cannot grow or flip a position. `Closed` is terminal.
6. Total share supply equals the sum of holders' balances, including shares held by `BatchAllocator` for unclaimed intents and the locked `MIN_SHARES`.
7. Escrow leaves `BatchAllocator` only as a settled deposit into the vault an intent names or as a withdrawal by its depositor; unspent escrow can be withdrawn at any time.
8. Cumulative ε never decreases, equals the sum of accepted releases, and a release that would pass the cap is refused.
9. A posted release cannot be changed: epochs and pinned blocks strictly increase, so a digest is never overwritten.
10. A malicious token or venue callback cannot re-enter the vault's accounting.
11. `allocate` succeeds only on a vault whose terms are locked, and locked terms and the adapter allowlist never change.
12. The volatility clause refuses only orders that add exposure and changes no state. The estimate is updated only when the mark's timestamp advances, and no mark is counted twice.
13. Fee shares are minted only while `Active` and on a fresh mark, never above the locked fee terms, and the fee high-water mark never falls.
14. `redeemSharesRequested` equals the sum of standing redeem requests, and shares under a request cannot be transferred.

## 7. Test strategy

Three suites, all run in CI except the fork test. Current case counts are in the README.

**Contract tests** (`contracts/test-js/`, `npm run test:contracts`) deploy the contracts to an in-process chain:

- share pricing at marked NAV, the first-deposit lock and vault construction (`share-pricing`, `vault-construction`);
- `preview → checkAndConsumeBefore → execute → result check` and the atomic revert (`core-flow`);
- mark age, `poke()`, the three freeze tiers and `resume()` (`mark-poke`, `freeze-tiers`, `lifecycle`);
- `unwind()` and the bounty floor (`unwind`, `unwind-floor`);
- the terms lock and `termsHash` (`terms-lock`);
- the volatility clause (`stress`) and the reference terms (`reference`);
- the redemption queue (`redeem-queue`);
- factory, trade terms and fees (`marketplace`);
- escrow, nonces, deadlines, cancellation, settlement root, claims and skipped vaults (`batch-flow`);
- registration, the release anchor and the noise pledge (`registry`, `noise-commit`);
- the reporter: the scale formula, reproducibility, domain separation by epoch and `statsVersion`, ledger monotonicity and exhaustion, the simulator's separation, and a release the registry accepts (`reporter`);
- `PerplAdapter` against a mock of Perpl's exchange (`perpl-mock`), the keeper and the track-record script (`keeper`, `track-record`);
- one run from registration to withdrawal (`e2e-journey`).

`perpl-fork.test.mjs` runs the Perpl path against a fork of Monad testnet (`npm run test:perpl`); it needs the network and is not part of the default CI run.

**Invariant and fuzz tests** (`contracts/test/`, Foundry, `npm run test:invariant`) call the contracts in arbitrary order:

- `Mandate.invariant.t.sol` — invariants 1, 5, 6, 11, 12 and 14 on the vault, guard and mock adapter;
- `Fee.invariant.t.sol` — invariant 13 and the direction and daily-trade terms under fee minting;
- `Registry.invariant.t.sol` — invariants 8 and 9;
- `Reentrancy.t.sol` — invariant 10, with an asset token that re-enters `allocate()` and `withdraw()`;
- `UnwindBountyFloor.t.sol` — the bounty floor and its cap, fuzzed over floor and vault size.

**Demo server tests** (`npm run test:web`) cover the signing allowlist, gas bounds, the live batcher and reporter, and recovery of the newest deployment on boot.

**End-to-end demo flow:**

1. An operator creates a mandate through the factory.
2. Allocators deposit to escrow and sign intents; the epoch settles and they claim shares.
3. An order inside the mandate fills.
4. An order past a term reverts before the venue changes.
5. A price move takes the vault past its drawdown term; `poke()` freezes it and pays the caller.
6. `unwind()` closes the position in steps and the vault ends `Closed`.
7. The reporter posts a release and the UI reads the digest and ε back from the registry.
8. An allocator withdraws.

## 8. Non-goals and limits of v1

- **Allocator anonymity.** No shielded transfers; intents are public at settlement.
- **Private-demand statistics.** No watchlist and no private intent signal exist, so nothing private is aggregated.
- **Reporter decentralisation.** One signing key. The chain cannot check that noise was added.
- **Batcher decentralisation.** One address, which can delay or leave out intents but cannot take funds.
- **Price safety.** The mock venue proves contract behaviour, not price integrity or liquidity. The mark is trusted.
- **Arbitrary venues.** Only venues with a reviewed adapter; a vault is bound to one adapter for life.
- **Automatic liquidation.** `unwind()` and `poke()` need a caller. The bounties are the incentive; there is no keeper network.
- **Bounded loss.** The drawdown term bounds when liquidation starts, not where it ends.
- **Volatility-scaled leverage.** The clause refuses new exposure; it does not shrink existing exposure, and it uses no external volatility source.
- **Amending terms.** Not possible, even to tighten them.
- **Agent quality.** The guard limits behaviour; it does not make a strategy good.
- **Mainnet and real funds.** Testnet only. No external audit has been done; the reviews in this repository are internal.

The full list, with the reasoning for each, is under "Honest limitations" in the README.

## 9. Future extensions

- A guarded TWAP or multi-source price and a circuit breaker for venues whose mark the operator can influence.
- An audit and listing process for third-party adapters.
- A threshold reporter and verifiable sampling, so that noise can be checked rather than pledged.
- Shielded batch funding, so that allocator-to-vault links are not public at settlement.
- A Rényi-DP accountant and a multi-epoch release schedule; derived sensitivities for Sharpe and max drawdown.
- An external audit, then mainnet with real USDC.

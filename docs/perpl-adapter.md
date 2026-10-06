# Perpl venue adapter

Status 2026-10-06: `contracts/src/perpl/PerplAdapter.sol` is written. It has been tested against Perpl's real exchange on a local fork of Monad testnet (`npm run test:perpl`). No Perpl-backed vault has been deployed to Monad testnet yet: that costs testnet MON and is a team decision. The hosted demo still runs on the deterministic MockVenue with mock USDC.

## Why Perpl

Perpl is an order-book perpetuals exchange on Monad. A mandate is only as good as the price its terms are checked against. On the mock venue the deployer's keeper sets that price. On Perpl the price is the exchange's own mark, and Perpl writes the mark's timestamp on chain. So the guard's `maxMarkAgeSeconds` check reads the real age of a price the operator does not control.

## Addresses and parameters

| | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| Exchange (proxy) | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` |
| Collateral | aUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (6 decimals) | AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` |

Sources: <https://docs.perpl.xyz> and the ABI in `PerplFoundation/dex-sdk` (`crates/sdk/abi/dex/Exchange.json`). The adapter's interface `contracts/src/perpl/IPerplExchange.sol` declares only the calls it uses.

Testnet perpetual ids, read from `getPerpetualInfoV2`: BTC 16, ETH 32, SOL 48, MON 64. The adapter maps the mandate's market ids 0 to 3 to these four, in that order. Price and lot decimals are read from the exchange on every call, so they are never hard-coded.

## How it works

- **Same order format.** Orders are encoded exactly as for `MockVenueAdapter`: `abi.encode(int256 sizeDeltaE18, uint256 limitPriceE18)` for market 0, or with a leading `uint256 marketId`. An agent written for the mock venue does not change. A size that is not a whole number of Perpl lots reverts `LotNotRepresentable`.
- **One Perpl account per vault.** Perpl keys accounts by `msg.sender`. On a vault's first trade the adapter deploys a `PerplSubaccount` for it (CREATE2, salted by the vault address) and opens a Perpl account with it. Only the adapter can tell the subaccount what to do. Withdrawn money can only go to its vault.
- **Margin moves only during a trade.** `MandateVault.execute()` approves its own cash to its adapter, calls the adapter, and sets the approval back to zero in the same call. The adapter pulls what the worst fill the limit allows would need: the added notional at the venue leverage plus 2%, the loss against the mark that Perpl makes an entry collateralise one for one, and a fee float. It never pulls more than the vault holds. The first trade needs at least Perpl's 100 aUSD account minimum in the vault, and reverts `BelowAccountMinimum` otherwise. After the fill it sends every free unit in the Perpl account back to the vault. Between trades the vault's money is its own cash plus the margin locked in open positions.
- **The limit stays near the mark.** On an order book the limit is the price the vault may be filled at. With no bound, an agent could rest a far-off order from an account of its own and have the vault take it, moving the vault's money to itself in one fill. The guard's `maxPriceDeviationBps` covers this only when a mandate sets it, and 0 disables it. So the adapter has its own bound, `maxAdverseLimitBps`, set once at deployment and the same for every vault on it: a buy limit more than that above Perpl's mark, or a sell limit more than that below it, reverts `LimitTooFarFromMark` before any money moves. Only the costly side is bounded. The tests deploy with 300 (3%). It caps what one fill can move to an agent's own order, it does not remove it: within the band, self-dealing is still possible, and the mandate's own deviation term should be set tighter.
- **Fills are all or nothing.** Orders are sent immediate-or-cancel and fill-or-kill at the agent's limit price. The vault then checks that the position Perpl reports matches what `preview()` promised and reverts the whole transaction otherwise, as it does for the mock venue.
- **Equity at Perpl's mark.** `markEquity()` is the vault's cash, plus the free and locked balance of its Perpl account, plus each open position's margin, its price PnL at Perpl's mark and the funding Perpl has booked against it (`premiumPnlCNS`, the term Perpl's SDK adds to delta PnL). `markedAt` is the oldest `markTimestamp` among the markets held, or market 0's when flat. That is Perpl's clock, never `block.timestamp`.
- **Unwind.** `reduce()` sends Perpl's reduce-only close orders, at most 1% through the mark, for the requested fraction of every open position. So an unwind step can never flip or grow a position. Close orders may fill in part. If Perpl refuses a market's order (paused, stale mark, no liquidity within 1%, a slice under its minimum), the adapter tries once more for the whole position and otherwise skips that market for this step. One stuck market never holds up the rest. Free collateral goes back to the vault after each step.
- **Sweep.** Anyone may call `sweep(vault)`. It moves free collateral from the vault's Perpl account to the vault and nowhere else.

## What the fork test shows

`contracts/test-js/perpl-fork.test.mjs` forks Monad testnet in process and runs the full stack against Perpl's deployed exchange. Nothing is broadcast. The steps:

1. A permissionless `createMandate` through `MandateFactory`, with aUSD as the asset.
2. An allocation of 500 aUSD.
3. A 0.001 BTC long. Perpl records 100 lots, side long. The margin sits at Perpl, and equity stays within fees of 500.
4. An order that would take the position past its $200 cap. The guard refuses it with `PositionNotionalExceeded` before Perpl sees it.
5. A sell of 0.002 BTC with its limit 3% under the mark, the edge of the adapter's band. The position goes through flat into a 0.001 short, which Perpl records as side 1.
6. A freeze by anyone once the 5-second holding limit has passed (`maxHoldingSeconds`).
7. Unwind steps until the vault is `Closed`. The position at Perpl is zero and the Perpl account is empty.
8. The allocator withdraws everything except the vault's `MIN_SHARES` dust.

The test forks only at a block whose BTC mark is at most 10 seconds old, because the run spends about 25 of Perpl's 60 seconds. With that it passed ten runs in a row on 2026-10-06. Run it with:

```bash
npm run test:perpl            # PERPL_FORK_RPC overrides https://testnet-rpc.monad.xyz
```

`npm test` skips it, because it needs the network.

## What the offline tests show

`contracts/test-js/perpl-mock.test.mjs` runs the adapter against `MockPerplExchange`, a small stand-in for Perpl's exchange, with no network. It reaches what a fork cannot choose. It runs in `npm test` and in CI.

- An open moves only its margin to Perpl, and equity counts both sides.
- A fill above the agent's limit is killed whole, and no money moves.
- A limit past the adapter's 3% band on the costly side is refused, with no money moved, even when the mandate sets no deviation term. 3% is accepted on both sides.
- The adapter cannot be deployed with a band of 0 or above 100%.
- A vault under Perpl's 100-unit account minimum is refused before any transfer.
- Unwind closes one market while Perpl refuses the other, and finishes once it reopens.
- Closes that fill in part keep unwinding until the position is gone.
- A stale mark on one market is skipped like a refusal.
- A withdrawal Perpl holds back stays in equity, and `sweep` returns it later.
- Funding booked against a position lowers equity and settles on close.
- A venue whose views revert can still be frozen, and allocators can take the cash-only exit.

## Findings while building it

- **Contract accounts work.** A contract can create a Perpl account, trade as a taker and rest a post-only order. Verified on the fork, 2026-10-06. Perpl's ABI has a whitelist event, but it was not enforced on testnet that day.
- **Taker orders need `maxNegPnlCollatBPS` above 0.** With 0, every immediate-or-cancel taker order reverted `TakerOrderSettlementFailed` with result code 14, from contracts and from plain accounts alike. The adapter sets it to 10000, so Perpl's own check never binds. The price bound is the agent's limit price, held within the adapter's `maxAdverseLimitBps` of the mark, plus the guard's `maxPriceDeviationBps` when the mandate sets it.
- **Cost.** A 0.001 BTC round trip, open and close as a taker, cost about 0.07 aUSD on the fork.
- **Mark age.** Perpl refuses prices older than 60 seconds (`refPriceMaxAgeSec`). Ages measured over the testnet RPC were 1 to 31 seconds. A mandate's `maxMarkAgeSeconds` should be 60, or close to it, on Perpl. A tighter value will see `MarkTooOld` between Perpl's updates.

## Testnet deployment

`contracts/script/deploy-perpl.mjs` deploys a Mandate stack on Perpl's testnet exchange. It has two steps:

```
PERPL_WALLET_FILE=<wallet json> npm run deploy:perpl            # guard, registry, PerplAdapter, factory, one mandate
PERPL_WALLET_FILE=<wallet json> npm run deploy:perpl -- smoke   # allocate 150 aUSD, open and close 0.001 BTC, withdraw
```

- The deployer is the factory owner, the mandate's agent and the smoke step's allocator. It needs MON for gas and, for the smoke step, at least 150 aUSD.
- The mandate trades BTC only, with a $200 position cap, 2% drawdown and a 60-second mark age. The adapter uses 2x venue leverage and a 3% limit band.
- Addresses go to `contracts/deployments/perpl-10143.json`. The script refuses to run if that file exists.
- Both steps were rehearsed on a local fork of Monad testnet on 2026-10-06. The smoke step allocated 150 aUSD and withdrew 149.86.

## Limits

- **Funding is as fresh as Perpl's position record.** `markEquity()` reads `premiumPnlCNS` as Perpl reports it. Whether Perpl's view accrues funding up to the current block or only to its last settlement was not checked on the fork, where every position was seconds old.
- **Perpl's own liquidation is not modelled.** Perpl liquidates an isolated position whose margin runs out. The mandate's drawdown term should freeze the vault long before that, at the venue leverage the adapter uses. But a gap past both would show up as a lost margin, not as an unwind.
- **A stalled feed stalls the exit.** When Perpl's mark goes stale, Perpl refuses orders. An unwind step then closes nothing in that market, and the vault stays `Frozen` until the feed returns. Full-price withdrawal needs a fresh mark until the vault is `Closed`. Meanwhile an allocator can take `withdrawUnpriced()`: their share of the vault's cash, capped at the share's worth at the last mark, in exchange for their part of what is still at Perpl. If Perpl's exchange cannot be read at all, the vault counts that as no mark, so `freezeUnobservable()` and this exit still work.
- **Withdrawal rate limit.** Perpl rate-limits withdrawals (`getWithdrawAllowanceData`). If the adapter's sweep is refused, the money stays in the Perpl account and is still counted in equity. Anyone can retry it with `sweep(vault)`.
- **One venue leverage per adapter.** The adapter opens every position at one venue leverage, set when it is deployed. That decides how much margin sits at Perpl. The mandate's own leverage term is measured separately, against the vault's whole equity.
- **Refusals are tested against a mock.** The skip path for a paused, stale or illiquid market is exercised against `MockPerplExchange`, whose errors follow those seen on the fork. Perpl's real exchange has not been seen refusing a market mid-unwind.
- **Not audited.** Like the rest of the contracts, the adapter has had internal review only.

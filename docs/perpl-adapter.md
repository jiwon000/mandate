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
- **Margin moves only during a trade.** `MandateVault.execute()` approves its own cash to its adapter, calls the adapter, and sets the approval back to zero in the same call. The adapter pulls the margin the order needs: the added notional at the venue leverage, plus 2%, plus a fee float. The first trade pulls at least Perpl's 100 aUSD account minimum. After the fill it sends every free unit in the Perpl account back to the vault. Between trades the vault's money is its own cash plus the margin locked in open positions.
- **Fills are all or nothing.** Orders are sent immediate-or-cancel and fill-or-kill at the agent's limit price. The vault then checks that the position Perpl reports matches what `preview()` promised and reverts the whole transaction otherwise, as it does for the mock venue.
- **Equity at Perpl's mark.** `markEquity()` is the vault's cash, plus the free and locked balance of its Perpl account, plus each open position's margin and its price PnL at Perpl's mark. `markedAt` is the oldest `markTimestamp` among the markets held, or market 0's when flat. That is Perpl's clock, never `block.timestamp`.
- **Unwind.** `reduce()` sends Perpl's reduce-only close orders, at most 1% through the mark, for the requested fraction of every open position. So an unwind step can never flip or grow a position. Free collateral goes back to the vault after each step.
- **Sweep.** Anyone may call `sweep(vault)`. It moves free collateral from the vault's Perpl account to the vault and nowhere else.

## What the fork test shows

`contracts/test-js/perpl-fork.test.mjs` forks Monad testnet in process and runs the full stack against Perpl's deployed exchange. Nothing is broadcast. The steps:

1. A permissionless `createMandate` through `MandateFactory`, with aUSD as the asset.
2. An allocation of 500 aUSD.
3. A 0.001 BTC long. Perpl records 100 lots, side long. The margin sits at Perpl, and equity stays within fees of 500.
4. An order that would take the position past its $200 cap. The guard refuses it with `PositionNotionalExceeded` before Perpl sees it.
5. A sell of 0.002 BTC. The position goes through flat into a 0.001 short, which Perpl records as side 1.
6. A freeze by anyone once the 5-second holding limit has passed (`maxHoldingSeconds`).
7. Unwind steps until the vault is `Closed`. The position at Perpl is zero and the Perpl account is empty.
8. The allocator withdraws everything except the vault's `MIN_SHARES` dust.

It passed three runs in a row on 2026-10-06. Run it with:

```bash
npm run test:perpl            # PERPL_FORK_RPC overrides https://testnet-rpc.monad.xyz
```

`npm test` skips it, because it needs the network.

## Findings while building it

- **Contract accounts work.** A contract can create a Perpl account, trade as a taker and rest a post-only order. Verified on the fork, 2026-10-06. Perpl's ABI has a whitelist event, but it was not enforced on testnet that day.
- **Taker orders need `maxNegPnlCollatBPS` above 0.** With 0, every immediate-or-cancel taker order reverted `TakerOrderSettlementFailed` with result code 14, from contracts and from plain accounts alike. The adapter sets it to 10000, so Perpl's own check never binds. The price bound is the agent's limit price, plus the guard's `maxPriceDeviationBps` when the mandate sets it.
- **Cost.** A 0.001 BTC round trip, open and close as a taker, cost about 0.07 aUSD on the fork.
- **Mark age.** Perpl refuses prices older than 60 seconds (`refPriceMaxAgeSec`). Ages measured over the testnet RPC were 1 to 31 seconds. A mandate's `maxMarkAgeSeconds` should be 60, or close to it, on Perpl. A tighter value will see `MarkTooOld` between Perpl's updates.

## Limits

- **Funding is not in equity.** Perpl's funding payments (`premiumPnlCNS`) are left out of `markEquity()`. A long-held position's NAV drifts from the truth by the funding it has paid or earned.
- **Perpl's own liquidation is not modelled.** Perpl liquidates an isolated position whose margin runs out. The mandate's drawdown term should freeze the vault long before that, at the venue leverage the adapter uses. But a gap past both would show up as a lost margin, not as an unwind.
- **A stalled feed stalls the exit.** When Perpl's mark goes stale, Perpl refuses orders. Then `unwind()` reverts too, and the vault stays `Frozen` until the feed returns. Withdrawal still needs a fresh mark until the vault is `Closed`. On the mock venue the stale-feed exit (`freezeUnobservable`, five unwinds, withdraw) works because the mock venue fills without a fresh price.
- **Withdrawal rate limit.** Perpl rate-limits withdrawals (`getWithdrawAllowanceData`). If the adapter's sweep is refused, the money stays in the Perpl account and is still counted in equity. Anyone can retry it with `sweep(vault)`.
- **One venue leverage per adapter.** The adapter opens every position at one venue leverage, set when it is deployed. That decides how much margin sits at Perpl. The mandate's own leverage term is measured separately, against the vault's whole equity.
- **Not audited.** Like the rest of the contracts, the adapter has had internal review only.

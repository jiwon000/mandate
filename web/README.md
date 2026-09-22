# Mandate Web

The demo runs against a real chain. `npm run web` compiles the contracts, starts an
in-process EDR node, deploys the whole system, funds four mandates, and serves the
page in front of it. Every number on screen is a contract read; every button is a
transaction. Nothing is mocked in the browser.

## Run

From the repository root:

```bash
npm run web
```

First boot takes 20-25 seconds — it compiles and deploys before the server answers.
Then open `http://localhost:3000`.

The page talks to the node over `/rpc`, which the server proxies to the in-process
chain, so no wallet extension and no testnet funds are needed. The header's
"Connect allocator" button adopts one of the node's funded accounts.

## What is deployed

| Contract | Role |
| --- | --- |
| `MockUSDC` | 6-decimal asset |
| `DeterministicMockVenue` | Priced venue the agents trade against; publishes `priceE18` and `updatedAt` |
| `MockVenueAdapter` | Previews and executes orders; marks each vault's equity to the venue price |
| `MandateRiskGuard` | Holds each mandate's limits, decides before and after every trade, freezes on `poke()` |
| `MandateVault` x4 | One per mandate: allocator shares in, execute-only agent |

The four mandates carry deliberately different terms — Tight Mandate accepts a 3%
drawdown and a 4-second mark age, Momentum Vector accepts 20% and 30 seconds — so a
single market move produces four different outcomes.

## The four screens

**Market** — the mandate book. Drawdown, leverage and mark age each shown against the
limit the allocator accepted, not against each other. A vault past a limit reads
`OVER LIMIT`; it only reads `FROZEN` once someone has called `poke()`.

**Agent** — one mandate in detail: NAV per share against its high-water mark, every
limit as a bar against what is used, the vault and agent addresses, and a NAV chart
that fills in as the price moves.

**Allocate** — `approve()` then `allocate()` for real. `withdraw()` stays enabled
while a vault is frozen, because freezing closes the agent's door, not the
allocator's. Both doors do close on a mark past its age limit: shares are priced
off that mark in both directions, and neither screen will let you sign against a
price the guard would reject.

**Live Risk** — the control room:

- `-5% shock` moves the venue price and re-marks every vault.
- `Send order inside mandate` is a real `execute()` that passes the guard.
- `Send over-limit order` is a real `execute()` that reverts; the feed prints the
  guard's own custom error (`LeverageExceeded`, `MarkTooOld`, `AgentNotActive` once frozen),
  decoded from the revert data.
- `poke(...)` is callable by anyone. When a vault is past its limits it freezes the
  agent and pays the caller a bounty out of the vault. The demo calls it from an
  account that is neither the allocator nor the agent.
- The block-cadence toggle switches the node between 1s and 12s blocks. At 12s, a
  mandate that asks for a mark no older than 4s can no longer be enforced —
  `poke()` and `execute()` start reverting with `MarkTooOld`.
- `Reset demo` redeploys everything.

## A note on the block cadence

EVM timestamps are integer seconds, so Monad's 0.3s blocks cannot be expressed as a
`block.timestamp` delta. The toggle therefore compares 1s against 12s, which
understates the real difference rather than overstating it.

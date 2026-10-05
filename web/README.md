# Mandate Web

The demo runs against a real chain. `npm run web` compiles the contracts, starts an
in-process EDR node, deploys the whole system, funds four mandates, and serves the
page in front of it. `npm run web:live` serves the same page in front of a deployment
on a live RPC (Monad testnet) and signs the visitor's clicks with demo keys the server
holds. Either way every number on screen is a contract read; every button is a
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

For the live mode, fill `.env` (`MONAD_RPC_URL`, `DEMO_MNEMONIC`, `DEMO_ADMIN_TOKEN`),
run `npm run deploy:demo` once, then `npm run web:live`. The server boots from
`web/deployments/<chainId>.json`, runs the oracle itself and answers `/rpc` as a
signing proxy: `eth_accounts` lists the six demo accounts, `eth_sendTransaction` is
checked against a per-role allowlist and signed server-side, reads go upstream.
`eth_signTypedData_v4` is answered for one thing only, the allocator's
`AllocationIntent` on this deployment's batch allocator, and the server is the
batcher and the reporter behind the Batch and Privacy screens (`web/live-desks.mjs`).
The full description, the env table and the hosting unit are in the root README
under "Live testnet demo".

## What is deployed

| Contract | Role |
| --- | --- |
| `MockUSDC` | 6-decimal asset |
| `DeterministicMockVenue` | Priced venue the agents trade against; publishes `priceE18` and `updatedAt` |
| `MockVenueAdapter` | Previews and executes orders; marks each vault's equity to the venue price |
| `MandateRiskGuard` | Holds each mandate's limits, decides before and after every trade, freezes on `poke()` |
| `MandateVault` x4 | One per mandate: allocator shares in, execute-only agent |
| `BatchAllocator` | Escrow and signed allocation intents, netted into each vault per epoch |
| `MandateRegistry` | Terms registry, outcome records and the privacy budget for published statistics |

The four mandates carry deliberately different terms — Tight Mandate accepts a 3%
drawdown and a 4-second mark age, Momentum Vector accepts 20% and 30 seconds — so a
single market move produces four different outcomes. On a live chain the oracle is a
paid transaction every 5 seconds, so the live profile widens Tight Mandate's mark age
to 10 seconds; everything else is identical (`web/mandates.mjs` is the one definition).

## The six screens

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

**Batch** — allocations netted per epoch. The allocator deposits escrow into
`BatchAllocator`, signs an `AllocationIntent` (EIP-712, off-chain, free), and once the
epoch has ended one `settleEpoch()` moves the net amount into each vault. Shares are
then claimed with a Merkle proof. The batcher is the server: `web/chain.mjs` on the
in-process chain, `web/live-desks.mjs` on a live one, where the queue is shared by
every visitor. There an intent is checked against the chain when it arrives and again
before settlement, and one the chain would still refuse is left out of the batch (the
toast says which and why) instead of sinking the epoch.

**Privacy** — a differentially private release. The reporter pools each vault's
per-mark return, clips it, adds Laplace noise and posts the digest of the result to
`MandateRegistry` with `postLeaderboard()`; the registry adds the release's ε to a
running total and refuses a release past its cap. The inputs are public NAV marks, so
this demonstrates the release and its on-chain budget, not secrecy of the data.

On a live chain both are transactions the deployer pays for, so they are bounded:
8 intents an epoch, 3 settlements a minute, one release every 2 minutes, and an
hourly allowance of signed gas for the two together. Queued intents, claim proofs and
the reporter's samples are held in memory; a restart or a reset drops them. Shares
settled before a restart stay claimable on chain, but the proof has to be rebuilt from
the `settleEpoch()` calldata, which the demo does not do.

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
  `poke()` and `execute()` start reverting with `MarkTooOld`. (Local mode only; a
  live chain's cadence is its own, so the toggle is hidden there.)
- `Reset demo` redeploys everything. In live mode it is the operator's button: it
  only appears when the page is opened with `?admin=<DEMO_ADMIN_TOKEN>`, and the
  server also resets by itself once a visitor has left two or more vaults frozen.

In live mode the note under the control room replaces the cadence note: it names the
network, says that the server is signing with demo keys, and reports the oracle's
current cadence (every 5s while someone is watching, every 5 minutes otherwise), the
number of marks pushed and the gas spent so far. Each feed entry's block label links
to the transaction on the explorer.

## A note on the block cadence

EVM timestamps are integer seconds, so Monad's 0.3s blocks cannot be expressed as a
`block.timestamp` delta. The toggle therefore compares 1s against 12s, which
understates the real difference rather than overstating it.

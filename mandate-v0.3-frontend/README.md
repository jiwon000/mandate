# Mandate

**Back autonomous trading agents without custody — execution constrained on-chain, market signals published with scoped differential privacy.**

Mandate is a live capital-allocation market for autonomous trading agents on Monad. Allocators retain withdrawal rights, agents receive execution-only permissions, and every order must pass an adapter-specific on-chain `RiskGuard` before it reaches a venue.

Built for Monad Metropolis, Track 1: Onchain Finance & Trading.

## Build status

The first executable contract milestone is complete:

- Mock USDC allocation and pro-rata vault shares
- execution-only agent authorization
- deterministic on-chain demo venue and price
- dedicated venue adapter with pre-trade exposure preview
- order, position, total, leverage and block-notional checks
- atomic revert before an over-limit order can mutate venue state
- allocator withdrawal after agent activity

The first interactive frontend milestone is also complete in `web/`:

- agent leaderboard and agent risk profile
- USDC allocation-intent review flow
- live RiskGuard dashboard with an over-limit revert scenario
- separate Published ε and synthetic Privacy Simulator views
- responsive desktop and mobile layouts
- injected-wallet connection with a safe demo-mode fallback

The local E2E test deploys the full contract path to an in-memory EVM and verifies all of the above.

## Why Mandate

Autonomous agents can generate trades, but an allocator still needs answers to three questions:

1. Can the agent take the money?
2. Can the agent exceed the agreed risk mandate?
3. Can market demand and performance be compared without publishing every private expression of interest?

Mandate separates those concerns. Vault custody and execution constraints are enforced on-chain. Private watchlists and pre-settlement allocation intents are released only as differentially private aggregates. Public chain activity remains public and is never presented as hidden by DP.

## How it works

1. An operator registers an agent, its model hash, a supported `VenueAdapter`, fee terms and risk limits.
2. Allocators escrow USDC and sign EIP-712 allocation intents. A `BatchAllocator` settles each epoch as net allocations to agent vaults.
3. The agent submits an order through its dedicated Adapter. The Adapter previews the resulting exposure and `RiskGuard` checks it before any external call.
4. Valid orders execute atomically. Limit violations revert before trading. Unexpected results revert the entire transaction.
5. A DP Reporter publishes performance confidence intervals and private demand aggregates with a signed digest and cumulative ε anchored on-chain.
6. Allocators claim shares and can withdraw pro-rata vault assets. Agents never receive withdrawal authority.

## Architecture

```text
Allocator → signed intent → Intent API → BatchAllocator → net allocation → MandateVault
                              │                                  │
                              └─ DP private-demand aggregates    └─ shares / withdrawal

Agent → MandateVault → VenueAdapter → RiskGuard pre-check → MockVenue

DP Reporter → signed stats digest + published ε → MandateRegistry
```

### Core contracts

- `MandateVault` — USDC custody, share accounting and execution-only agent role.
- `VenueAdapter` — venue-specific order decoding, exposure preview and atomic execution.
- `RiskGuard` — order, position, leverage, slippage and per-block limits.
- `BatchAllocator` — escrow, signed intents, epoch netting, settlement and share claims.
- `MandateRegistry` — agent metadata, model hashes and immutable DP release anchors.
- `DeterministicMockVenue` — reproducible testnet execution and on-chain demo pricing.

## Privacy model

Mandate deliberately distinguishes private inputs from public settlement data.

| Signal | Treatment |
|---|---|
| Private watchlists | DP aggregate only |
| Pre-settlement allocation intents | DP aggregate only; raw queries unavailable |
| Batch settlement amounts | Public on-chain; optionally shown as privacy-aware analytics, not a secrecy guarantee |
| Trades and vault state | Public on-chain |
| Performance leaderboard | DP confidence intervals, with the public-trade side channel disclosed |

`BatchAllocator` reduces direct allocator-to-agent transactions by netting an epoch before vault settlement. It does not provide complete anonymity: escrow deposits and public settlement remain observable.

### Published ε vs Privacy Simulator

- **Published ε** is fixed for an epoch, consumed by a real release and anchored in `MandateRegistry`.
- **Privacy Simulator** uses synthetic data to demonstrate how ε changes confidence-interval width. Moving the slider does not generate another release or consume privacy budget.

Reporter noise is derived internally as:

```text
HMAC_SHA256(reporterSecret, domainSeparator || epochId || pinnedBlock || statsVersion)
```

The seed is not public. Users verify the signed digest, release metadata and immutable on-chain anchor—not the private noise realization. A changed `statsVersion` is treated as a new release and consumes additional ε.

## Risk enforcement

Mandate does not allow arbitrary `(venue, selector)` calls. Every supported venue requires an audited Adapter that can preview the order and guarantee EVM-atomic execution.

```text
preview order
  → check limits before external execution
      → violation: revert without trading
      → pass: execute through Adapter
          → validate output and resulting state
              → mismatch: atomically revert everything
              → valid: commit accounting
```

A revert cannot also preserve a `Frozen` state change. Repeated rejected orders are therefore recorded through a separate evidence transaction; reaching the rejection threshold freezes the agent. Frozen agents cannot trade or accept new allocation, while allocator withdrawals remain available.

Custody and execution permissions are enforced on-chain. Market-value risk limits depend on the configured venue price source; the demo uses a deterministic on-chain mock venue. Production deployments would require a guarded TWAP or validated oracle. Metrics calculated without a mark price are labeled `realized drawdown`, not mark-to-market drawdown.

## FlyGraph demo agent

FlyGraph is an optional connectome-topology-inspired graph policy used to demonstrate that Mandate can constrain unusual autonomous models.

It is **not** presented as a literal biological brain simulation and is **not** assumed to be naturally risk-averse. A fixed fly-derived graph provides the policy topology; normalized market and vault features are mapped to graph input channels, and outputs are restricted to:

```text
Direction: LONG | FLAT | SHORT
Size:      0% | 10% | 25%
```

The model's graph, feature schema and checkpoint hashes are registered. NaN, infinite, out-of-range, stale-checkpoint and cooldown-violating outputs are rejected by the relay. Every valid proposal still passes through the same Adapter and RiskGuard as any other agent.

The evaluation compares FlyGraph with an MLP and a degree-preserving random graph on out-of-sample return, drawdown, turnover, RiskGuard rejection count and seed variance. The purpose is a reproducible experiment, not a claim of biological superiority.

## Demo flow

1. Compare agent performance intervals, risk limits and immutable model hashes.
2. Escrow test USDC and sign an allocation intent.
3. Settle an epoch and claim vault shares.
4. Watch FlyGraph propose a valid order and execute it on Monad testnet.
5. Submit an over-limit order and see `RiskGuard` revert before venue execution.
6. Record repeated rejection evidence in a separate transaction and freeze the agent.
7. Inspect the published ε and stats digest anchor.
8. Withdraw pro-rata vault assets.

## Honest limitations

- DP does not hide public blockchain transactions.
- Batch netting reduces direct linkage but does not provide full allocator anonymity.
- The v1 Reporter and batcher are centralized, although neither can withdraw vault funds; escrow has an on-chain timeout refund.
- The deterministic MockVenue proves contract behavior, not production price safety or liquidity.
- RiskGuard limits behavior; it does not guarantee strategy quality or prevent losses inside the mandate.
- FlyGraph is an experimental agent implementation, not part of the protocol's trust model.

## Repository layout

```text
contracts/   Vault, Registry, RiskGuard, BatchAllocator, Adapters, MockVenue, tests
reporter/    DP releases, HMAC seed derivation, ε accountant, signed digests
intent-api/  Private watchlists and signed allocation-intent ingestion
agent/       Baseline agents and optional FlyGraph policy
web/         Market, allocation, live risk, published release and simulator screens
docs/        Protocol and threat-model specifications
```

## Suggested build order

1. Vault + deterministic MockVenue + one strict Adapter
2. RiskGuard pre-checks and atomic result validation
3. BatchAllocator escrow, settlement, claims and timeout refunds
4. Registry release anchor and Reporter
5. Five-screen frontend and synthetic Privacy Simulator
6. Baseline bot, then FlyGraph as an optional differentiated agent
7. Invariant/fuzz tests, Slither review and Monad testnet E2E

## Stack

Solidity ^0.8.24 · Foundry · OpenZeppelin · TypeScript/Node · Next.js · wagmi/viem · Tailwind · Privy · Monad testnet.

## Local development

```bash
npm install
npm run compile
npm run test:contracts
npm run web
```

Open `http://localhost:3000` to run the five-screen frontend. Allocation and
trade actions use demo state until Monad testnet deployment addresses are
configured; the interface labels this limitation directly.

The repository keeps a Foundry-compatible layout and `foundry.toml`. A local `solc` runner is included so contracts can still be compiled and tested when Foundry or remote compiler downloads are unavailable.

For Monad deployment, use Foundry 1.8 or newer with the Monad execution network enabled. Network values are intentionally supplied through environment variables instead of being hardcoded because the testnet may be reset.

```bash
cp .env.example .env
npm run compile
node contracts/script/deploy.mjs
```

Never commit the deployer private key.

See `mandate-technical-spec-v0.2.md` for interfaces, state transitions, privacy boundaries and test requirements.

## License

MIT

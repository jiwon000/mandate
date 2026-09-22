# Mandate

**수탁 권한 없이 자율 트레이딩 에이전트를 지원합니다. 실행 권한은 온체인에서 제한하고, 시장 신호는 범위를 명시한 차등 프라이버시로 공개합니다.**

Mandate는 Monad에서 자율 트레이딩 에이전트에 자본을 배분하는 온체인 시장입니다. 배분자는 출금 권한을 유지하고, 에이전트는 거래 실행 권한만 받습니다. 모든 주문은 거래 venue에 도달하기 전에 전용 Adapter와 온체인 `RiskGuard` 검사를 통과해야 합니다.

Monad Metropolis Track 1인 Onchain Finance & Trading을 대상으로 제작되었습니다.

## 구현 현황

현재 저장소에는 Vault·Adapter·RiskGuard 핵심 기능과 BatchAllocator가 구현되어 있습니다. 여기에는 marked equity 기반 손실 한도, EIP-712 배분 intent, escrow, 에폭별 순배분, Merkle 지분 claim, intent 취소와 미사용 escrow 환불이 포함됩니다.

현재 프라이버시 경계는 명확합니다. 정산에 포함된 allocation intent와 서명은 정산 calldata에서 공개됩니다. 배치 순정산은 직접 연결을 줄이지만 완전한 익명성을 제공하지 않습니다. 원본 intent가 체인에 전혀 올라가지 않는다는 더 강한 v0.2 문구는 아직 구현되지 않았고, DP Reporter와 비공개 Intent API도 예정 사항입니다.

`web/` 데모는 서버 시작 시 in-process chain을 배포하고 네 개의 테스트 Vault를 실행합니다. MockVenue는 온체인 가격으로 현금과 미실현 손익을 반영한 equity를 계산하고 그 가격으로 지분을 발행·상환합니다. 청산이나 funding 비용은 구현하지 않았으므로 실제 파생상품 회계의 증거로 사용할 수 없습니다.

## 현재 동작하는 기능

- marked NAV 기준 Mock USDC 예치와 Vault 지분 발행
- 에이전트의 실행 전용 권한과 출금 권한 차단
- 결정론적 MockVenue와 온체인 가격
- Adapter 기반 주문 해석 및 외부 호출 전 사전 노셔널 계산
- 주문·포지션·총노셔널·레버리지·블록당 노셔널·cooldown 검사
- 한도 초과 주문의 사전 revert와 원자적 결과 검증
- 가격 mark가 오래되면 거래·예치·출금을 막는 `maxMarkAgeSeconds`
- high-water mark 대비 marked drawdown 검사와 permissionless `poke()`
- drawdown 초과 시 Vault 동결 및 호출자 bounty 지급
- 첫 예치 share inflation을 막는 `MIN_SHARES` 잠금
- EIP-712 intent 기반 에폭 배치 예치, Merkle claim, 취소와 환불

로컬 테스트는 in-memory EVM에 전체 경로를 배포합니다. 현재 컴파일과 계약 테스트 19개가 통과합니다.

## 동작 흐름

1. 운영자가 하나의 `VenueAdapter`에 연결된 Vault를 배포하고 `MandateRiskGuard`에 한도를 설정합니다.
2. 배분자가 USDC를 escrow에 예치하고 EIP-712 allocation intent에 서명합니다.
3. `BatchAllocator`가 에폭 종료 후 Vault별 순액을 한 번 예치하고 사용자가 Merkle proof로 지분을 claim합니다.
4. 에이전트가 Adapter를 통해 주문을 제출하면 Adapter가 노셔널과 예상 포지션을 계산합니다.
5. RiskGuard가 외부 호출 전에 한도를 확인합니다. 위반 주문은 venue 상태를 바꾸지 않고 revert됩니다.
6. 체결 후 가격 mark와 drawdown을 다시 검사합니다. 한도 초과 Vault는 동결되지만 배분자의 출금과 지분 이전은 유지됩니다.
7. 누구나 `poke()`를 호출해 최신 mark 기준 drawdown을 확인할 수 있습니다.

## 보안 및 프라이버시 한계

Mandate는 임의의 `(venue, selector)` 호출을 허용하지 않습니다. 지원 venue마다 주문 해석, 사전 상태 계산, 원자적 외부 호출을 보장하는 Adapter가 필요합니다. 시장가치 위험 한도는 설정된 가격 소스에 의존하며, 데모는 결정론적 MockVenue를 사용합니다. 실서비스에서는 TWAP 또는 검증된 oracle과 stale/deviation guard가 필요합니다.

DP는 공개 블록체인 거래를 숨기지 않습니다. 비공개 watchlist와 정산 전 demand 집계만 DP 대상이며, 거래·Vault 상태·escrow·정산 금액은 공개될 수 있습니다. 현재 웹 데모의 수치는 서버가 시작할 때 배포한 로컬 체인의 contract read와 transaction을 사용합니다.

## 데모 실행

```bash
npm ci
npm run compile
npm run test:contracts
npm run web
```

브라우저에서 `http://localhost:3000`을 엽니다. 포트가 사용 중이면 `PORT=3001 npm run web`처럼 다른 포트를 지정할 수 있습니다.

데모 화면은 Market, Agent, Allocate, Live Risk로 구성됩니다. Allocate에서 테스트 USDC를 예치하고, Live Risk에서 정상 주문·한도 초과 주문·가격 충격·`poke()` 동결·동결 후 출금 흐름을 확인할 수 있습니다. 배치 intent 정산은 계약 테스트로 검증되며 현재 웹 화면에는 연결되지 않았습니다.

## 저장소 구조

```text
contracts/src/          Vault, RiskGuard, Adapter, BatchAllocator, interface, mock
contracts/test-js/      in-process Hardhat EVM 계약 테스트
contracts/script/       deploy.mjs와 keeper.mjs
contracts/tools/        로컬 solc 컴파일러와 EIP-712/Merkle helper
web/                    Market, Agent, Allocate, Live Risk 화면과 데모 서버
docs/                   마일스톤 설계 문서
mandate-v0.3-frontend/  이전 프론트엔드 설계 스냅샷
```

## 다음 작업

Registry와 DP Reporter, 공개 ε anchor, 배치 흐름의 웹 연결, baseline/FlyGraph 에이전트, invariant·fuzz 테스트, 외부 감사와 Monad 테스트넷 배포가 남아 있습니다. FlyGraph는 실험용 정책이며 프로토콜의 보안 근거가 아닙니다.

자세한 인터페이스와 상태 전이는 [`mandate-technical-spec-v0.2.md`](mandate-technical-spec-v0.2.md)와 [BatchAllocator 마일스톤 문서](docs/batch-allocator-milestone2.md)를 참고하세요.

---

# Mandate (English)

**Back autonomous trading agents without custody — execution constrained on-chain, market signals published with scoped differential privacy.**

Mandate is a live capital-allocation market for autonomous trading agents on Monad. Allocators hold withdrawal rights no agent or operator can revoke, agents receive execution-only permissions, and every order must pass an adapter-specific on-chain `RiskGuard` before it reaches a venue.

Built for Monad Metropolis, Track 1: Onchain Finance & Trading.

## Implementation status

The sections below describe the target v1 product. The current repository implements the Vault/Adapter/RiskGuard core with mark-to-market drawdown enforcement, and the milestone-2 `BatchAllocator`: escrow, EIP-712 authorization, per-vault epoch deposits, Merkle claims, cancellation and refunds of unspent escrow. See [the milestone-2 design and ABI](docs/batch-allocator-milestone2.md).

**Current privacy boundary:** included allocation intents and signatures become public in settlement calldata. Net deposits do not hide those allocator-to-vault links. The stronger v0.2 statement that raw intents never go on-chain is not implemented. There is no DP Reporter or private Intent API yet.

Registry/ε anchors, fee accounting, FlyGraph and a published Monad testnet deployment are pending. The four-screen frontend in `web/` runs against an in-process chain that the server deploys on boot. The mock venue marks each vault's equity (cash plus unrealised PnL) to its on-chain price and shares are minted and redeemed at that mark; it does not liquidate positions or charge funding, so a passing open-position withdrawal test is not evidence of production derivatives accounting. Foundry fuzzing and an external security review are also pending.

## Build status

The first executable contract milestone is complete:

- Mock USDC allocation and vault shares priced at marked NAV
- execution-only agent authorization
- deterministic on-chain demo venue and price
- dedicated venue adapter with pre-trade exposure preview
- order, position, total, leverage and block-notional checks
- atomic revert before an over-limit order can mutate venue state
- allocator withdrawal after agent activity
- mark-age limit: a vault whose venue price is older than `maxMarkAgeSeconds` cannot trade, allocate or withdraw until the price is refreshed
- mark-to-market drawdown against a high-water mark, checked after every trade and by anyone through `poke()`; a breach freezes the vault and pays the caller a bounty
- first-deposit share lock (Uniswap-V2-style `MIN_SHARES`) against share-price inflation
- epoch batch allocation: escrow, EIP-712 intents, netting, Merkle claims, cancellation and refunds

The local test suite (`npm run test:contracts`) deploys the full contract path to an in-memory EVM and verifies all of the above.

## Why Mandate

Autonomous agents can generate trades, but an allocator still needs answers to three questions:

1. Can the agent take the money?
2. Can the agent exceed the agreed risk mandate?
3. Can market demand and performance be compared without publishing every private expression of interest?

Mandate separates those concerns. Vault custody and execution constraints are enforced on-chain. Private watchlists and pre-settlement allocation intents are released only as differentially private aggregates. Public chain activity remains public and is never presented as hidden by DP.

## How it works

1. An operator deploys a vault bound to one `VenueAdapter` and configures its risk limits in `MandateRiskGuard`. (Planned: a registry with model hashes and fee terms.)
2. Allocators escrow USDC and sign EIP-712 allocation intents. A `BatchAllocator` settles each epoch as net allocations to agent vaults.
3. The agent submits an order through its dedicated Adapter. The Adapter previews the resulting exposure and `RiskGuard` checks it before any external call.
4. Valid orders execute atomically. Limit violations revert before trading. Unexpected results revert the entire transaction. After the trade the guard re-marks the vault and checks drawdown.
5. Anyone can call `poke()` between trades. If the marked drawdown exceeds the mandate, the vault freezes and the caller is paid a small bounty out of the vault.
6. Allocators claim shares and can withdraw at the marked price, position included. Agents never receive withdrawal authority.
7. (Planned) A DP Reporter publishes performance confidence intervals and private demand aggregates with a signed digest and cumulative ε anchored on-chain.

## Architecture

```text
Allocator → signed intent → Intent API (planned) → BatchAllocator → net allocation → MandateVault
                              │                                            │
                              └─ DP private-demand aggregates (planned)    └─ shares / withdrawal

Agent → MandateVault → MockVenueAdapter → MandateRiskGuard pre-check → DeterministicMockVenue
                                          └─ post-trade mark / poke() → freeze + bounty

DP Reporter → signed stats digest + published ε → MandateRegistry            (planned)
```

### Core contracts

- `MandateVault` — USDC custody, share accounting at marked NAV, execution-only agent role, freeze that keeps withdrawals open.
- `MockVenueAdapter` (`IVenueAdapter`) — order decoding, exposure preview, atomic execution and `markEquity()` for the guard.
- `MandateRiskGuard` — order, position, total, leverage, per-block and cooldown limits before a trade; mark age and mark-to-market drawdown after it and on `poke()`.
- `BatchAllocator` — escrow, signed intents, epoch netting, settlement and share claims.
- `DeterministicMockVenue` — reproducible execution and on-chain demo pricing.
- `MandateRegistry` (planned) — agent metadata, model hashes and immutable DP release anchors.

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
              → valid: re-mark equity, update the high-water mark, check drawdown and mark age
```

A revert cannot also preserve a `Frozen` state change, so a rejected order never freezes anything by itself. Instead the guard re-marks the vault after every successful trade, and anyone can call `MandateRiskGuard.poke(vault, adapter)` between trades. If NAV per share sits more than `maxDrawdownBps` below its high-water mark, the guard freezes the vault and the vault pays the caller `POKE_BOUNTY_BPS` (0.05%) of its assets. Frozen vaults cannot trade or accept new allocation; withdrawals and share transfers stay open.

Custody and execution permissions are enforced on-chain. Market-value risk limits depend on the configured venue price source; the demo uses a deterministic on-chain mock venue. Production deployments would require a guarded TWAP or validated oracle. Drawdown is mark-to-market against that price source, and `markedAt` is the venue's own price timestamp rather than `block.timestamp`, so a fast chain cannot make a stale feed look fresh.

## FlyGraph demo agent

FlyGraph is an optional connectome-topology-inspired graph policy used to demonstrate that Mandate can constrain unusual autonomous models. It is not implemented yet; the demo agents are scripted.

It is **not** presented as a literal biological brain simulation and is **not** assumed to be naturally risk-averse. A fixed fly-derived graph provides the policy topology; normalized market and vault features are mapped to graph input channels, and outputs are restricted to:

```text
Direction: LONG | FLAT | SHORT
Size:      0% | 10% | 25%
```

The model's graph, feature schema and checkpoint hashes are registered. NaN, infinite, out-of-range, stale-checkpoint and cooldown-violating outputs are rejected by the agent runner before submission. Every valid proposal still passes through the same Adapter and RiskGuard as any other agent.

The evaluation compares FlyGraph with an MLP and a degree-preserving random graph on out-of-sample return, drawdown, turnover, RiskGuard rejection count and seed variance. The purpose is a reproducible experiment, not a claim of biological superiority.

## Demo flow

The demo in `web/` has four screens: Market, Agent, Allocate and Live Risk.

1. Compare the four mandates on Market: drawdown, leverage and mark age are each shown against the limit the allocator accepted.
2. Open one on Agent: NAV per share against its high-water mark, and every limit as a bar against what is used.
3. Approve and allocate test USDC on Allocate; shares are minted at the marked NAV.
4. Send an order inside the mandate on Live Risk and watch it pass the guard.
5. Send an over-limit order and see the guard's own custom error decoded from the revert data, before any venue state changes.
6. Push a price shock, then call `poke()` from an account that is neither allocator nor agent: the vault past its drawdown limit freezes and the caller is paid the bounty.
7. Switch the node to 12-second blocks: the mandate that asks for a 4-second mark can no longer be enforced and starts reverting with `MarkTooOld`.
8. Withdraw from the frozen vault at marked NAV while its position is still open.

The batch flow (escrow, signed intents, settlement, claims) is covered by contracts and tests, not by the demo UI. DP releases and the ε anchor are planned.

## Honest limitations

- DP does not hide public blockchain transactions.
- Batch netting reduces direct linkage but does not provide full allocator anonymity.
- The v1 Reporter and batcher are centralized, although neither can withdraw vault funds; escrow has an on-chain timeout refund.
- The deterministic MockVenue proves contract behavior, not production price safety or liquidity.
- RiskGuard limits behavior; it does not guarantee strategy quality or prevent losses inside the mandate.
- A withdrawal needs a mark inside the vault's `maxMarkAgeSeconds`. Redeeming against a price nobody can vouch for would hand the difference to whoever stays, so the vault refuses rather than guesses. No agent, operator or freeze can hold a withdrawal - only a stale mark can, and only until it refreshes.
- A vault is permanently bound to the adapter it was constructed with. There is no venue migration path.
- One vault with a stale mark or in `Frozen` state reverts the whole epoch in `BatchAllocator.settleEpoch()`, since settlement allocates to every vault in a single transaction. The batcher has to leave such vaults out of the batch.
- The first deposit into a vault permanently locks `MIN_SHARES` (1e3 share units) to a dead address so a first depositor cannot inflate the share price against later allocators. The first depositor pays that dust.
- `poke()` pays its bounty out of the vault, so a breach costs allocators 0.05% on top of the drawdown. That is the price of not needing a trusted keeper.
- On a testnet deployment the venue price comes from the deployer's keeper script, so the mark is only as honest as that keeper. A production venue would supply its own price.
- A withdrawal is capped by the cash the vault holds. Shares are priced at the marked value of the open position, but the vault can only pay out what is not tied up in it; the unpaid part of a claim stays as shares until the agent frees up cash.
- FlyGraph is an experimental agent implementation, not part of the protocol's trust model.

## Repository layout

```text
contracts/src/          MandateVault, MandateRiskGuard, MockVenueAdapter, BatchAllocator, interfaces, mocks
contracts/test-js/      node:test suites against an in-process Hardhat 3 (EDR) chain
contracts/script/       deploy.mjs and keeper.mjs for a live RPC
contracts/tools/        solc compile runner and the EIP-712 / Merkle helper (batch.mjs)
web/                    Market, Agent, Allocate and Live Risk screens, demo server and chain
docs/                   Milestone design notes
mandate-v0.3-frontend/  Historical snapshot of an earlier frontend design; not built or served
```

## Roadmap

Done:

1. Vault + deterministic MockVenue + one strict Adapter
2. RiskGuard pre-checks, atomic result validation, mark-to-market drawdown and `poke()` freeze
3. BatchAllocator escrow, settlement, claims and refunds

Next:

4. Registry release anchor and DP Reporter
5. Published-release and Privacy Simulator screens; batch flow in the UI
6. Baseline bot, then FlyGraph as an optional differentiated agent
7. Invariant/fuzz tests, Slither review, external audit and a published Monad testnet deployment

## Stack

Solidity 0.8.37 (EVM `prague`) · Hardhat 3 (EDR) · OpenZeppelin 5.4 · ethers 6 · Node 22+ · dependency-free HTML/JS frontend · Monad testnet.

## Local development

```bash
npm ci
npm run compile
npm run test:contracts
npm run web
```

Open `http://localhost:3000` for the interactive demo. Every number on screen is a contract read and every button is a transaction against the in-process chain the server deploys on boot. See [web/README.md](web/README.md) for the screen list and demo interactions.

Use Node 22.14 or newer. After `npm ci`, the local `solc` 0.8.37 runner and the in-process Hardhat tests work without network access. `foundry.toml` mirrors the layout for anyone who wants to point Foundry tooling at the sources; the test suite itself does not use Foundry. CI (`.github/workflows/ci.yml`) runs compile and tests on every push and pull request.

## Deploying to a live RPC

Network values are supplied through environment variables instead of being hardcoded because the testnet may be reset.

```bash
cp .env.example .env                                # MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, AGENT_ADDRESS
npm run compile
node --env-file=.env contracts/script/deploy.mjs    # writes contracts/deployments.latest.json
node --env-file=.env contracts/script/keeper.mjs    # keeps the venue price fresh and calls poke()
```

`npm run deploy:monad` and `npm run keeper:monad` run the same scripts with the variables taken from the shell environment.

The deployed vault is configured with `maxMarkAgeSeconds = 30`, so without the keeper every `execute`, `allocate` and `withdraw` starts reverting with `MarkTooOld` thirty seconds after deployment. The keeper walks the mock price inside a band and calls `poke()` each tick; a drawdown breach freezes the vault and the keeper collects the bounty. Never commit the deployer private key.

See `mandate-technical-spec-v0.2.md` for interfaces, state transitions, privacy boundaries and test requirements. The spec predates the mark-to-market guard; sections that changed carry an implementation note.

## License

MIT. See [LICENSE](LICENSE).

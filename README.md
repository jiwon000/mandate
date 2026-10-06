# Mandate

**수탁 권한 없이 자율 트레이딩 에이전트를 지원합니다: 실행 권한은 온체인에서 제한되고, 공개된 성과 통계는 온체인에서 검증 가능한 차등 프라이버시 예산 안에서 게시됩니다.**

Mandate는 Monad에서 자율 트레이딩 에이전트에 자본을 배분하는 온체인 시장입니다. 배분자의 돈은 Vault 컨트랙트에 남고, 에이전트는 주문 실행 권한 하나만 받습니다. 모든 주문은 거래소에 닿기 전에 온체인 `RiskGuard`의 조건 검사를 통과해야 합니다. 배분자가 답해야 할 질문이 "이 트레이더를 믿을 수 있나"에서 "이 조건을 받아들일 수 있나"로 바뀝니다.

Monad Metropolis Track 1 (Onchain Finance & Trading) 출품작입니다. 영문 문서는 아래 [Mandate (English)](#mandate-english)에 있습니다.

- 공개 데모: <https://mandate-e4kb.onrender.com> (Monad 테스트넷, chainId 10143. 지갑 없이 사용 가능)
- 제출 준비 현황과 제출 글: [`docs/submission/`](docs/submission/README.md)

## 현재 상태 (2026-10-06)

| 구성 요소 | 상태 |
| --- | --- |
| Vault, RiskGuard, Adapter, 조건 잠금, 동결과 `unwind()` | Monad 테스트넷 배포, 공개 데모에서 동작 |
| `MandateFactory` 무허가 볼트 개설 | 공개 데모 Launch 화면 (브라우저 지갑 필요) |
| 조건 19개: 리스크 한도 11, 거래 조건 6, 수수료 2 | 온체인 강제, 모두 `termsHash` 하나로 잠김 |
| `BatchAllocator`, `MandateRegistry`, DP 리포터 | 공개 데모 Batch·Privacy 화면 |
| `PerplAdapter` (Monad의 perp 거래소 Perpl) | Monad 테스트넷에 배포. Perpl 테스트넷 거래소에서 입금, 거래, 출금 왕복 1회, 이어서 규칙 기반 에이전트 스크립트로 3회 실행해 주문 10건 체결, 한도 초과 주문 5건 온체인 거부 |
| 거래소와 USDC | mock. 테스트넷 가격은 팀의 키퍼가 넣음 |
| 보안 검토 | 내부 리뷰 4라운드. 외부 감사 없음 |
| 테스트 | 계약 93개, 서버 61개, Foundry invariant 13개와 reentrancy 3개. CI에서 실행 |

## 조건

조건은 첫 예치 전에 `lockTerms()`로 잠기고, 그 뒤로는 누구도 바꿀 수 없습니다. 잠기기 전의 Vault는 예치를 받지 않습니다. 배분자는 `termsHash` 하나로 자신이 읽은 조건과 체인의 조건이 같은지 확인합니다.

| 묶음 | 조건 | 위반하면 |
| --- | --- | --- |
| 주문 전 검사 | 주문·포지션·총 노셔널, 레버리지, 블록당 노셔널, 거래 간격, 허용 마켓, 방향(롱·숏 전용), 지정가의 mark 대비 괴리, 하루 거래 횟수 | 주문이 revert되고 거래소 상태는 바뀌지 않음 |
| 변동성 조항 | 실현 변동성 추정 기간, 스트레스 horizon, k-sigma | 노출을 늘리는 주문을 `StressBreach`로 거절. 줄이는 주문은 통과 |
| mark 기준 검사 | high-water mark 대비 drawdown, 당일 손실, 최대 보유 시간 | 누구나 `poke()`로 동결하고 bounty(0.05%)를 받음 |
| 가격 신선도 | `maxMarkAgeSeconds` (최대 60초) | 거래·예치 불가. 3배 넘게 갱신이 없으면 누구나 `freezeUnobservable()`로 동결 |
| 수수료 | 운용보수 연 최대 5%, 성과보수 최대 30% (high-water mark 초과분) | 위반 개념 없음. Vault가 신선한 mark에서만 지분으로 징수 |

동결되면 에이전트는 멈추고 배분자의 출금은 열려 있습니다. 누구나 `unwind()`를 다섯 번 호출해 포지션을 20%씩 reduce-only로 닫을 수 있고(mark 대비 슬리피지 1% 이내, bounty 0.01%), 마지막에 Vault는 `Closed`가 됩니다. 가격 피드가 멈춘 동결 Vault에서는 `withdrawUnpriced()`로 현금 몫만 먼저 받아 나갈 수 있습니다.

각 조건의 정확한 의미와 권장 범위는 영문 [What each term bounds](#what-each-term-bounds), 동결 규칙의 설계는 [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md)에 있습니다.

## 동작 흐름

1. 누구나 `MandateFactory.createMandate()` 한 번으로 Vault를 배포하고 조건을 설정·잠근 뒤 `MandateRegistry`에 등록합니다. 승인하는 사람은 없고, 범위를 벗어난 값은 guard와 팩토리가 거절합니다.
2. 배분자는 Vault에 직접 예치하거나, `BatchAllocator`에 escrow를 넣고 EIP-712 intent에 서명합니다. 배치는 에폭마다 Vault별 순액을 한 번에 예치하고, 배분자는 Merkle proof로 지분을 받습니다.
3. 에이전트가 Adapter로 주문을 보내면 Adapter가 주문 뒤의 노출을 미리 계산하고, RiskGuard가 외부 호출 전에 조건을 검사합니다.
4. 체결 뒤 guard가 Vault를 다시 평가합니다. 거래 사이에는 누구나 `poke()`로 같은 검사를 할 수 있습니다.
5. 조건을 넘은 Vault는 동결되고, 누구나 `unwind()`로 정리합니다. 배분자는 언제든 marked NAV로 출금합니다.
6. 리포터는 공개된 Vault 수익률에 Laplace 노이즈를 더한 통계를 서명해 `MandateRegistry.postLeaderboard()`에 게시하고, 레지스트리는 쓴 ε을 누적해 상한을 넘는 release를 거절합니다.

## Monad를 쓰는 이유

가격 신선도 조건에는 바닥이 있고, 그 바닥은 블록 간격입니다. mark는 트랜잭션으로 갱신되므로 다음 블록의 트랜잭션이 읽을 때 이미 한 블록 간격만큼 오래돼 있습니다. "4초보다 오래된 가격은 믿지 않는다"는 조건은 블록이 4초 안에 오는 체인에서만 지킬 수 있습니다. 12초 블록에서는 다음 블록이 생기기 전에 mark가 만료되어, 오라클 갱신과 같은 블록 뒤쪽에 들어간 거래만 통과하고 나머지는 `MarkTooOld`로 revert됩니다.

로컬 빌드는 오라클을 12초에 한 번으로 묶는 스위치로 이 상황을 재현합니다. 공개 데모의 오라클은 5초마다 갱신하는 유료 트랜잭션이라 가장 엄격한 Vault가 10초 조건을 쓰고, 연속 `poke()` 8회가 모두 1~5초 된 mark로 통과한 기록이 영문 [Recorded run on Monad testnet](#recorded-run-on-monad-testnet)에 있습니다.

## 참여자별로 얻는 것

| 참여자 | 얻는 것 | 내는 것 |
| --- | --- | --- |
| 배분자 | 돈을 Vault에 둔 채 에이전트에 맡기고, 잠긴 조건을 `termsHash`로 확인하며, 언제든 marked NAV로 출금 | 운용보수와 성과보수, 동결 시 bounty |
| 에이전트 운영자 | 수탁 없이 남의 자본으로 거래할 권한, 조건 안에서의 운용보수 연 최대 5%와 성과보수 최대 30% | 조건을 바꿀 수 없음, 위반 시 동결 |
| 누구나 | 조건을 넘은 Vault를 `poke()`로 동결하면 0.05%, `unwind()` 한 번에 0.01% bounty | 가스 |

## 실행

```bash
npm ci
npm run compile
npm test                    # 계약 테스트와 서버 테스트
npm run web                 # http://localhost:3000, 서버가 띄운 in-process 체인
```

Node 22.14 이상이 필요합니다. 포트가 사용 중이면 `PORT=3001 npm run web`처럼 지정합니다. [Foundry](https://getfoundry.sh)가 있으면 `forge install` 뒤 `npm run test:invariant`로 invariant·reentrancy 테스트를, 네트워크가 있으면 `npm run test:perpl`로 Perpl 포크 테스트를 돌릴 수 있습니다.

화면은 Market, Agent, Allocate, Batch, Privacy, Launch, Live Risk입니다. 숫자는 모두 contract read이고 버튼은 모두 트랜잭션입니다. 로컬 빌드에만 있는 것은 Live Risk의 12초 mark 비교 스위치입니다.

Monad 테스트넷 위의 라이브 모드(`npm run deploy:demo`, `npm run web:live`), 서버가 대신 서명할 때의 안전장치, 오라클과 가스 정책은 영문 [Live testnet demo](#live-testnet-demo) 절에 있습니다. `.env`와 니모닉은 커밋하지 않습니다.

## 주장하지 않는 것

- 수익을 약속하지 않습니다. guard는 행동을 제한할 뿐 전략의 질을 보장하지 않습니다.
- 위험이 사라진다고 주장하지 않습니다. 언제 주문이 거절되고 언제 Vault가 동결되는지가 정해질 뿐, 조건 안의 손실과 가격 갭으로 조건을 넘는 손실은 여전히 생깁니다.
- 실제 거래소에서 거래한다고 주장하지 않습니다. 공개 데모의 거래소와 USDC는 mock이고, Perpl은 테스트넷에서 소액 거래만 해봤으며(약 1.5시간, 체결 10건) Perpl 팀과의 제휴는 없습니다.
- 사용자, 배분자, 예치 규모, 파트너가 있다고 주장하지 않습니다. 데모에 미리 올라간 배분자와 에이전트는 팀 서버의 테스트넷 키입니다.
- 차등 프라이버시가 비공개 데이터를 보호한다고 주장하지 않습니다. 이미 체인에 공개된 수익률에만 적용합니다.
- 감사를 받았다고 주장하지 않습니다. 검토는 모두 내부 리뷰입니다.
- 다른 체인에서는 만들 수 없다고 주장하지 않습니다. 주장은 더 좁습니다. 블록 간격보다 짧은 가격 신선도 조건은 지킬 수 없으므로, 4초 조건에는 4초 안에 블록이 오는 체인이 필요합니다.

## 한계

- 공개 데모의 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣습니다. MockVenue는 청산과 펀딩을 구현하지 않으므로 실제 파생상품 회계의 증거가 아닙니다. `PerplAdapter`는 테스트넷 배포본으로 소액 거래만 해봤습니다(0.001 BTC, 약 1.5시간).
- 차등 프라이버시는 공개 데이터에만 적용됩니다. 리포터는 이미 체인에 있는 수익률을 집계하므로 메커니즘과 온체인 ε 장부를 보여줄 뿐, 비공개 데이터를 보호하지 않습니다. 명시한 ε은 평균에 대해서만 정확합니다. 배치 intent와 서명은 정산 calldata에 공개됩니다.
- 데모의 batcher와 리포터는 팀 서버이고, claim proof를 메모리에 둡니다.
- guard는 행동을 제한할 뿐 전략의 질을 보장하지 않습니다. 실현 손실은 슬리피지와 가격 갭만큼 drawdown 조건을 넘을 수 있습니다.
- 외부 감사를 받지 않았습니다. 지금까지의 검토는 [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md)의 내부 리뷰입니다.

## 저장소 구조

```text
contracts/src/          MandateVault, MandateRiskGuard, MandateFactory, MandateRegistry, BatchAllocator, MockVenueAdapter
contracts/src/perpl/    PerplAdapter, PerplSubaccount, Perpl 거래소 인터페이스
contracts/src/mocks/    MockUSDC, DeterministicMockVenue, 오프라인 테스트용 MockPerplExchange
contracts/test-js/      in-process Hardhat EVM 계약 테스트와 Perpl 포크 테스트
contracts/test/         Foundry invariant·fuzz·reentrancy 테스트
contracts/script/       deploy-demo.mjs(데모 장부), deploy.mjs(단일 Vault), keeper.mjs
contracts/tools/        로컬 solc 컴파일러, EIP-712·Merkle helper
reporter/               DP release 계산, ε 장부, EIP-712 서명, Privacy Simulator
web/                    화면, 데모 서버, in-process 체인, 라이브 RPC 프록시, faucet
web/deployments/        체인별 배포 기록. 라이브 서버의 시작점
deploy/systemd/         Linux 호스트용 라이브 데모 유닛
docs/                   설계 문서, 보안 리뷰, Perpl 어댑터, 제출 자료(docs/submission/)
mandate-v0.3-frontend/  이전 프론트엔드 설계 스냅샷
```

## 문서

- [`mandate-technical-spec-v0.2.md`](mandate-technical-spec-v0.2.md): 인터페이스, 상태 전이, 프라이버시 경계. 이후 바뀐 절에는 구현 메모가 있음
- [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md): 동결 조건과 동결 이후 처리
- [`docs/perpl-adapter.md`](docs/perpl-adapter.md): Perpl 어댑터 구조, 포크 테스트, 발견 사항
- [`docs/batch-allocator-milestone2.md`](docs/batch-allocator-milestone2.md): 배치 배분 설계와 ABI
- [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md): 내부 보안 리뷰 4라운드
- [`docs/threat-model.md`](docs/threat-model.md): 위협별 대응과 남는 위험, 구성 요소별 장애 시 잃는 것과 남는 것
- [AI tool disclosure](#ai-tool-disclosure), [Third-party code](#third-party-code), [License](#license)

---

# Mandate (English)

**Back autonomous trading agents without custody: execution is constrained on-chain, and published performance stats carry a verifiable, on-chain differential-privacy budget.**

Mandate is a live capital-allocation market for autonomous trading agents on Monad. Allocators hold withdrawal rights no agent or operator can revoke, agents receive execution-only permissions, and every order must pass an adapter-specific on-chain `RiskGuard` before it reaches a venue.

Built for Monad Metropolis, Track 1: Onchain Finance & Trading.

## Implementation status

The current repository implements the Vault/Adapter/RiskGuard core with mark-to-market drawdown enforcement, the milestone-2 `BatchAllocator` (escrow, EIP-712 authorization, per-vault epoch deposits, Merkle claims, cancellation and refunds of unspent escrow), `MandateRegistry` (self-verifying agent catalog and DP release anchor), and a `reporter/` module that computes and signs real DP releases over public data. See [the milestone-2 design and ABI](docs/batch-allocator-milestone2.md).

**Current privacy boundary:** included allocation intents and signatures become public in settlement calldata. Net deposits do not hide those allocator-to-vault links. The stronger v0.2 statement that raw intents never go on-chain is not implemented. There is no private Intent API, and `reporter/` is scoped to public data only (2026-10-04): it DP-releases settlement amounts and trade returns, which are already on-chain, rather than the private watchlist/pre-settlement-intent signals the v0.2 spec sketches — those have no corresponding feature in this demo, so there is nothing yet to protect.

As of 2026-10-06 the contracts also carry permissionless registration through `MandateFactory`, trade terms and fees that the guard and vault enforce, several markets per venue, and a venue adapter for Perpl, deployed to Monad testnet and run once through Perpl's testnet exchange ([`docs/perpl-adapter.md`](docs/perpl-adapter.md#testnet-deployment)). They are live on the hosted demo since the 2026-10-06 redeploy (chain 10143 exposes a `factory` address and a `markets` list; see [Recorded run on Monad testnet](#recorded-run-on-monad-testnet)), though that deployment still trades against the mock venue, not Perpl's real exchange. The seven-screen frontend in `web/` runs against an in-process chain that the server deploys on boot, or, started with `--live`, against the same book deployed to Monad testnet through a server-signed proxy (see [Live testnet demo](#live-testnet-demo)). The mock venue marks each vault's equity (cash plus unrealised PnL) to its on-chain price and shares are minted and redeemed at that mark; it does not liquidate positions or charge funding, so a passing open-position withdrawal test is not evidence of production derivatives accounting. Foundry invariant/fuzz testing and an internal security review are implemented (`contracts/test/`, [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md) — now including a Round 4 pass over the marketplace surface); no external audit has been done yet.

## Build status

What the contracts and the demo do today:

- Mock USDC allocation and vault shares priced at marked NAV
- execution-only agent authorization
- deterministic on-chain demo venue and price
- dedicated venue adapter with pre-trade exposure preview
- order, position, total, leverage and block-notional checks
- atomic revert before an over-limit order can mutate venue state
- allocator withdrawal after agent activity
- mark-age limit: a vault whose venue price is older than `maxMarkAgeSeconds` cannot trade, allocate or withdraw until the price is refreshed
- mark-to-market drawdown against a high-water mark, checked after every trade and by anyone through `poke()`; a breach freezes the vault and pays the caller a bounty
- reduce-only unwind of a frozen position: anyone can call `unwind()` five times, each closes a fifth of the size at freeze inside a 1% slippage bound and pays 0.01% of cash; the last step moves the vault `Frozen -> Closed`
- one-way terms lock: `lockTerms()` makes the limits and the adapter allowlist final, a vault refuses deposits until its terms are locked, and `termsHash` is the value an allocator can quote
- volatility clause: the guard keeps a realised-volatility estimate built from the marks it sees (every trade, `poke()` and the side-effect-free `observe()` feed it), and an order that adds exposure is refused with `StressBreach` when a k-sigma move over the mandate's horizon would leave the vault past `maxDrawdownBps`; orders that reduce exposure are never stress-tested
- first-deposit share lock (Uniswap-V2-style `MIN_SHARES`) against share-price inflation
- `MandateFactory`: anyone deploys, configures, locks and registers a vault in one transaction; the owner only curates the adapter list, and the guard and factory enforce the ranges a value may take
- trade terms (`TradeTerms`): market allowlist, direction (long or short only), limit-price deviation from the mark and trades per day refuse the order; daily loss and maximum holding time let anyone freeze the vault
- fees (`FeeTerms`): a management fee (at most 5% a year) and a performance fee (at most 30%, only above the fee high-water mark), charged by minting shares to the agent, only on a fresh mark and only while `Active`; `termsHash` binds limits, trade terms and fees
- several markets on one venue; a 64-byte order still means market 0
- `PerplAdapter`: trades on Perpl, the perp exchange on Monad, through one sub-account per vault and marks equity at Perpl's on-chain mark and its timestamp; verified on a Monad testnet fork from open to withdrawal (`npm run test:perpl`), then deployed to testnet and run once from allocation to withdrawal against Perpl's testnet exchange (`npm run deploy:perpl`)
- web: a term sheet listing each locked term, its current value, what a breach does and a button that sends the order crossing it; browser-wallet connection; a test-USDC faucet limited per address and per IP; a launch form that calls `createMandate`
- epoch batch allocation: escrow, EIP-712 intents, netting, Merkle claims, cancellation and refunds — connected end to end in `web/`'s Batch screen (sign, queue, settle, claim), not only in the contract tests
- `MandateRegistry`: self-verifying `registerAgent()` reads `guard` from `vault.riskGuard()` itself rather than taking it as a parameter (claimed `RiskLimits` must hash to that guard's own locked `termsHash`; the adapter must be on its allowlist), and is restricted to the guard's owner since `fees`/`modelHash` have no on-chain ground truth to check (see "Security review" below — an earlier version trusted a caller-supplied `guard` address and was exploitable); `postLeaderboard()` gated by a single reporter's EIP-712 signature, enforcing strictly increasing epoch/pinnedBlock and an exact additive epsilon ledger against a configurable cap
- `reporter/`: clips trade returns to `[-c, c]` and DP-releases mean return, Sharpe and marked max drawdown via the Laplace mechanism, with deterministic HMAC-seeded noise and an epsilon ledger that mirrors `MandateRegistry`'s own accounting so a built release is never one the contract would refuse

The local test suite (`npm run test:contracts`) deploys the full contract path to an in-memory EVM and verifies all of the above (95 cases; the Perpl fork test needs the network and runs separately with `npm run test:perpl`). `npm run test:web` covers the demo server (61 cases): the signing allowlist, the gas bounds, the live batcher and reporter, and finding the newest book on boot. `npm run test:invariant` runs a separate Foundry suite — stateful invariant fuzzing of the Vault/RiskGuard/Adapter path (9 properties) and of `MandateRegistry`'s epsilon ledger (4 properties), plus malicious-ERC20 reentrancy tests — covering arbitrary call sequences the hand-written Hardhat tests don't attempt.

## Why Mandate

Autonomous agents can generate trades, but an allocator still needs answers to three questions:

1. Can the agent take the money?
2. Can the agent exceed the agreed risk mandate?
3. Can market demand and performance be compared without publishing every private expression of interest?

Mandate separates those concerns. Vault custody and execution constraints are enforced on-chain. Public chain activity (settlement amounts, trade returns) is DP-released as a performance leaderboard, never presented as hidden. The spec also calls for private watchlists and pre-settlement allocation intents to be released only as DP aggregates; this demo has no watchlist feature and nothing private to aggregate there yet, so that half is explicitly out of v1 scope rather than implemented against invented data.

## Who gets what

| Participant | Gets | Pays |
| --- | --- | --- |
| Allocator | Capital that stays in the vault, terms it can check against one `termsHash`, withdrawal at marked NAV that no agent or operator can block | Management and performance fees, the freeze bounty |
| Agent operator | Execution rights over other people's capital without custody; a management fee of at most 5% a year and a performance fee of at most 30% above the fee high-water mark | Terms it cannot change; a freeze when it breaches them |
| Anyone | 0.05% for freezing a vault past its terms with `poke()`, 0.01% for each `unwind()` step | Gas |

## How it works

1. Anyone calls `MandateFactory.createMandate()`: it deploys a vault bound to one listed `VenueAdapter`, sets its risk limits, trade terms and fees on the canonical `MandateRiskGuard`, locks them and lists the vault on `MandateRegistry`, in one transaction. The vault takes no deposit before the lock, and after it neither the terms nor the adapter allowlist can change. Fees are charged by the vault itself, as shares minted to the agent on a fresh mark.
2. Allocators escrow USDC and sign EIP-712 allocation intents. A `BatchAllocator` settles each epoch as net allocations to agent vaults.
3. The agent submits an order through its dedicated Adapter. The Adapter previews the resulting exposure and `RiskGuard` checks it before any external call.
4. Valid orders execute atomically. Limit violations revert before trading. Unexpected results revert the entire transaction. After the trade the guard re-marks the vault and checks drawdown.
5. Anyone can call `poke()` between trades. If the marked drawdown exceeds the mandate, the vault freezes and the caller is paid a small bounty out of the vault.
6. Allocators claim shares and can withdraw at the marked price, position included. Agents never receive withdrawal authority.
7. A DP Reporter (`reporter/`) publishes performance confidence intervals over public settlement data with a signed digest and cumulative ε anchored on `MandateRegistry`. Private demand aggregates are not implemented — see Privacy model.

## Architecture

```text
Allocator → signed intent → batcher (team server) → BatchAllocator → net allocation → MandateVault
                              │                                             │
                              └─ DP private-demand aggregates (not built)  └─ shares / withdrawal

Operator → MandateFactory.createMandate() → MandateVault + locked terms on MandateRiskGuard → MandateRegistry

Agent → MandateVault → VenueAdapter → MandateRiskGuard pre-check → venue
                       │              └─ post-trade mark / poke() → freeze + bounty → unwind()
                       ├─ MockVenueAdapter → DeterministicMockVenue   (hosted demo)
                       └─ PerplAdapter → PerplSubaccount → Perpl      (testnet, small trades)

reporter/ (DPReporter) → signed stats digest + published ε → MandateRegistry.postLeaderboard()
```

### Core contracts

- `MandateVault` — USDC custody, share accounting at marked NAV, execution-only agent role, freeze that keeps withdrawals open.
- `MandateFactory` — permissionless vault creation: deploy, configure, lock and register in one call, only on adapters the owner has listed.
- `MockVenueAdapter` (`IVenueAdapter`) — order decoding, exposure preview, atomic execution and `markEquity()` for the guard.
- `PerplAdapter` (`IVenueAdapter`) — the same interface against Perpl's exchange, one `PerplSubaccount` per vault, equity at Perpl's mark; see [`docs/perpl-adapter.md`](docs/perpl-adapter.md).
- `MandateRiskGuard` — order, position, total, leverage, per-block, cooldown and trade-term checks before a trade; mark age, drawdown, daily loss and holding time after it and on `poke()`.
- `BatchAllocator` — escrow, signed intents, epoch netting, settlement and share claims.
- `DeterministicMockVenue` — reproducible execution and on-chain demo pricing.
- `MandateRegistry` — self-verifying agent catalog (`registerAgent()` checks a claimed `RiskLimits` against the vault's own locked `termsHash` and adapter allowlist before accepting it) and the one place a DP release gets anchored (`postLeaderboard()`, gated by a single reporter's EIP-712 signature, not by who sends the transaction).

## Privacy model

Mandate deliberately distinguishes private inputs from public settlement data.

| Signal | Treatment |
|---|---|
| Private watchlists | Would need DP aggregation; the feature itself does not exist in this demo, so there is nothing to protect yet — scoped out of v1 rather than faked |
| Pre-settlement allocation intents | Same as above: no private-demand DP in v1 |
| Batch settlement amounts | Public on-chain; shown as privacy-aware analytics (`reporter/`), not a secrecy guarantee |
| Trades and vault state | Public on-chain |
| Performance leaderboard | Real DP confidence intervals over public trade returns (`reporter/`, Laplace mechanism), with the public-trade side channel disclosed |

`BatchAllocator` reduces direct allocator-to-agent transactions by netting an epoch before vault settlement. It does not provide complete anonymity: escrow deposits and public settlement remain observable.

As of 2026-10-04, `reporter/` computes and signs DP releases for the two rows above that are already public data — mean return, Sharpe and marked max drawdown, clipped to `[-c, c]` and noised with the Laplace mechanism (`scale = 2c / (N·ε)`, the standard report-noisy-mean sensitivity). That scale is derived from the mean's own sensitivity and reused for all three released numbers; the stated ε is therefore an exact, provable DP guarantee for the mean only, and the noisy Sharpe and max-drawdown figures should be read as indicative rather than independently budgeted — neither statistic's own sensitivity under clipped inputs has been derived. The two private-signal rows have no implementation: inventing a watchlist feature just to have something to anonymize would be privacy theater, so v1 only protects data that is genuinely sensitive and genuinely collected.

### Published ε vs Privacy Simulator

- **Published ε** is fixed for an epoch, consumed by a real release and anchored in `MandateRegistry.postLeaderboard()`.
- **Privacy Simulator** (`reporter/simulator.mjs`) uses synthetic data to demonstrate how ε changes confidence-interval width, reusing the real Reporter's own scale formula so the picture is never mathematically inconsistent with an actual release. It is a separate module that never imports the epsilon ledger or the reporter secret: moving the slider cannot generate another release or consume privacy budget, by construction, not just by convention.

Reporter noise is derived internally as:

```text
HMAC_SHA256(reporterSecret, domainSeparator || epochId || pinnedBlock || statsVersion)
```

The seed is not public. Users verify the signed digest, release metadata and immutable on-chain anchor—not the private noise realization. A changed `statsVersion` is treated as a new release and consumes additional ε. `reporter/`'s `EpsilonLedger` mirrors `MandateRegistry`'s own accounting exactly (same monotonic-epoch and additive-cumulative checks) so a release it builds is guaranteed either postable or rejected before anything is ever signed — the two cannot silently drift apart.

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

A freeze stops the agent but does not close the position, so the loss can keep growing while the vault waits. Anyone can call `MandateVault.unwind()` on a frozen vault. Each call asks the adapter to close a fifth of the size the position had at the freeze, reduce-only and inside `MAX_UNWIND_SLIPPAGE_BPS` (1%) of the venue mark, and pays the caller `UNWIND_BOUNTY_BPS` (0.01%) of cash. One step per block. When nothing is left on the book the vault moves `Frozen -> Closed`: no trades, no deposits, no more unwinding, and `withdraw()` no longer needs a fresh mark because there is no position left to misprice. The term therefore reads "the agent stops at X% and liquidation starts; the realised loss can exceed X% by slippage and gaps".

The terms an allocator reads are the terms they get. `MandateRiskGuard.lockTerms(vault)` is one-way: after it `configure()` and `setAdapter()` revert with `LimitsLocked`, and until it has happened `MandateVault.allocate()` reverts with `TermsNotLocked`. Money only ever enters behind terms the owner can no longer rewrite, which is what turns "read the terms" into a claim the contract enforces. `termsHash(vault)` is `keccak256(abi.encode(RiskLimits, TradeTerms, FeeTerms))`, so it covers all nineteen terms; the UI shows it and a registry release would anchor it. There is no timelock or amendment path: a different mandate is a new vault.

Every check above looks at what the order does to the position now. The volatility clause asks what the market could do to it next. The guard keeps, per vault, a variance rate built from the marks it has seen: each new mark contributes its squared return, weighted by the seconds since the previous mark, into an exponentially weighted average whose memory is `volWindowSeconds` (`v' = (window * v + r^2) / (window + dt)`). A first mark only seeds the series, a mark the guard has already seen changes nothing, and a vault with `volWindowSeconds = 0` has no clause. Before an order that would raise total exposure, the guard scales that variance to `stressHorizonSeconds`, takes `stressSigmasX10 / 10` standard deviations of it as the move, applies the move to the vault at the leverage the order would leave, and refuses the order with `StressBreach(sigmaBps, moveBps, stressedDrawdownBps)` if the resulting drawdown against the high-water mark would exceed `maxDrawdownBps`. So the drawdown term is enforced twice: after the fact by `poke()` and the freeze, and before the fact by refusing to add exposure the current tape could not carry. The refusal is per order: a reducing order always passes, nothing freezes, and the estimate decays as calm marks arrive. `stressQuote(vault, adapter, leverageX100)` returns the same three numbers without a transaction, which is what the UI's stressed-drawdown tile shows. The estimate is only as good as its sampling, so anyone can call `observe(vault, adapter)` to feed it a fresh mark; it has no bounty and no state change beyond the estimate itself.

Custody and execution permissions are enforced on-chain. Market-value risk limits depend on the configured venue price source; the demo uses a deterministic on-chain mock venue. Production deployments would require a guarded TWAP or validated oracle. Drawdown is mark-to-market against that price source, and `markedAt` is the venue's own price timestamp rather than `block.timestamp`, so a fast chain cannot make a stale feed look fresh.

### What each term bounds

| Term | What it bounds | On violation |
| --- | --- | --- |
| `maxOrderNotional` | notional of a single order at the mark price | order reverts, nothing else changes |
| `maxPositionNotional` | notional of the position the order would leave | order reverts |
| `maxTotalNotional` | total exposure after the order (equal to position notional on the single-market mock venue) | order reverts |
| `maxLeverageX100` | total exposure divided by marked equity (cash plus unrealised PnL), at order time only | order reverts |
| `minBlocksBetweenTrades` | blocks that must pass between two trades | order reverts |
| `maxBlockNotional` | notional traded inside one block | order reverts |
| `maxMarkAgeSeconds` | age of the venue price the guard is allowed to trust; required, at most 60 seconds | trade, allocation, withdrawal and `poke()` revert until the price is refreshed; past three times this age anyone can freeze the vault with `freezeUnobservable()` |
| `maxDrawdownBps` | NAV per share below its high-water mark, mark-to-market; required, at most 5000 (50%) | vault freezes: no more trades or deposits, withdrawals stay open; anyone can then `unwind()` the position in five steps and the vault ends `Closed` |
| `volWindowSeconds` | memory of the realised-volatility estimate: how many seconds of marks one squared return is averaged over (0 disables the clause) | no violation of its own; sets how fast the estimate reacts and decays |
| `stressHorizonSeconds` | the horizon the estimate is scaled to before the stress move is taken | no violation of its own |
| `stressSigmasX10` | the move, in tenths of a standard deviation over the horizon, an exposure-adding order must survive without breaching `maxDrawdownBps` (30 = 3 sigma) | order reverts with `StressBreach`; reducing orders are exempt; nothing freezes |
| `allowedMarkets` (`TradeTerms`) | bitmask of the venue markets the agent may trade; must allow at least one | order reverts with `MarketNotAllowed` |
| `direction` | long only, short only, or both | an order that would leave a position on the forbidden side reverts with `DirectionNotAllowed` |
| `maxPriceDeviationBps` | distance of the order's limit price from the mark (0 disables) | order reverts with `PriceDeviationExceeded` |
| `maxTradesPerDay` | exposure-adding trades in one UTC day; reducing trades are not counted (0 disables) | order reverts with `DailyTradesExceeded` |
| `maxDailyLossBps` | fall of NAV per share within one UTC day, measured from the last NAV marked before the day began (0 disables) | anyone can freeze the vault with `poke()`, as for drawdown |
| `maxHoldingSeconds` | time a position may stay open (0 disables) | anyone can freeze the vault with `poke()` once it has been open longer |
| `managementFeeBps` (`FeeTerms`) | yearly fee on the vault's value, at most 500 (5%) | not a limit; the vault mints it to the agent as shares on a fresh mark |
| `performanceFeeBps` | share of gains above the fee high-water mark, at most 3000 (30%) | not a limit; charged the same way, only above the previous peak |

Most terms reject one order and stop (the three volatility fields are one check). Four change the vault's state: drawdown, daily loss and holding time through a mark, and the mark-age term when no mark arrives for three times its length. The two fees are not limits. `configure()` refuses a mandate that leaves either at zero or past its range, so every vault can freeze. The guard's inputs are the adapter's order preview, the venue mark (price and its timestamp), the vault's share supply and cash, and the variance the guard itself has accumulated from those marks. No external volatility oracle is involved.

Suggested ranges for the volatility clause, with the reasoning. `volWindowSeconds`: at least a few dozen marks long, so one print does not dominate, and no longer than the regime you want to react to; Chainlink's realised-volatility feeds publish 24-hour, 7-day and 30-day windows sampled every 10 minutes, and the demo uses 60 to 300 seconds only because its marks arrive every second. `stressHorizonSeconds`: the time it takes to get out, which for a frozen vault is five `unwind()` blocks plus however long nobody calls them; 60 seconds to a day. `stressSigmasX10`: 20 to 40, two to four standard deviations, with 30 as the default; exchange portfolio-margin systems also stress against fixed scenario moves, but the exact ranges they use have not been verified here and are not quoted. Volatility-targeted position sizing is known to cut the left tail of returns (Man Group, "The Impact of Volatility Targeting"), which is the effect the clause borrows.

## Demo flow

The demo in `web/` has seven screens: Market, Agent, Allocate, Batch, Privacy, Launch and Live Risk. Launch appears only on a book with a factory and needs a browser wallet.

1. Compare the four mandates on Market: drawdown, leverage and mark age are each shown against the limit the allocator accepted.
2. Open one on Agent: NAV per share against its high-water mark, every limit as a bar against what is used, and a term sheet with a button per term that sends the order crossing it.
3. Approve and allocate test USDC on Allocate; shares are minted at the marked NAV.
4. Send an order inside the mandate on Live Risk and watch it pass the guard.
5. Send an over-limit order and see the guard's own custom error decoded from the revert data, before any venue state changes.
6. Push a price shock, then call `poke()` from any account (it is permissionless): the vault past its drawdown limit freezes and the caller is paid the bounty.
7. Select Range Carry after the same 2% shock. Its drawdown is about 3% against a 12% mandate, so nothing freezes, but the stressed-drawdown tile jumps: realised volatility is now roughly 200 bps over 120 seconds, three of those is a 6% move, and the vault would sit about 15% under water if the agent added exposure at 2.1x. The same "inside mandate" order that passed in step 4 now reverts with `StressBreach(196, 588, 1480)` before any venue state changes; the reduce-only order still passes. Leave the tape alone for about 70 seconds and the estimate decays under the limit, and the order passes again.
8. Hold the oracle to one mark per 12 seconds, as a 12-second chain would force (the local node keeps mining): the mandate that asks for a 4-second mark can no longer be enforced and spends most of each interval reverting with `MarkTooOld`.
9. Withdraw from the frozen vault at marked NAV while its position is still open.

10. On Batch, deposit to escrow, sign an `AllocationIntent` for the current epoch (off-chain, free), and once the epoch ends, settle it (the demo server plays the batcher role `deploy.mjs` gives the deployer key on Monad) and claim the resulting shares with the reconstructed Merkle proof.
11. On Privacy, click `postLeaderboard()` once a few price ticks have landed: the server pools public per-vault NAV returns, clips and Laplace-noises the mean/Sharpe/max-drawdown, signs a release and anchors it on `MandateRegistry`. The page re-reads `releaseOf()` straight from the contract and shows `VERIFIED ONCHAIN` once the digest it computed matches what it just read back — not just what the server's JSON claimed. The Privacy Simulator slider next to it never calls the chain: moving ε only recomputes a confidence interval over a synthetic example, using the real reporter's own `scale = 2·clipBound/(N·ε)` formula.

## What we do not claim

- No promise of returns. The guard limits behavior; it does not make a strategy good.
- No claim that risk goes away. The terms decide when an order is refused and when a vault freezes. Losses inside the mandate, and losses past it on a gap, still happen.
- No claim of trading on a real venue. The hosted demo's venue and USDC are mocks. Perpl has seen only small trades on testnet (0.001 BTC, about 1.5 hours in all), and there is no partnership with the Perpl team.
- No users, allocators, deposits or partners. The demo's preset allocator and agents are testnet keys on the team's server.
- No claim that differential privacy protects private data. It is applied only to returns that are already public on-chain.
- No audit. Every review so far is internal.
- No claim that this cannot be built on another chain. The claim is narrower: a mark-age term shorter than the block interval cannot be honored, so a 4-second term needs a chain whose blocks arrive within 4 seconds.

## Honest limitations

- DP does not hide public blockchain transactions.
- Batch netting reduces direct linkage but does not provide full allocator anonymity.
- The v1 Reporter and batcher are centralized, although neither can withdraw vault funds; escrow has an on-chain timeout refund.
- `reporter/`'s DP releases cover only data that was already public (settlement amounts, trade returns). The spec's "private watchlist" and "pre-settlement intent" DP aggregates are not implemented, because the demo has no watchlist feature and no private-intent signal to aggregate in the first place — building one just to anonymize it would not protect anything real.
- The deterministic MockVenue proves contract behavior, not production price safety or liquidity. It also does not settle: closing a position through `unwind()` books the realised PnL into the venue's cost basis instead of moving tokens, so a `Closed` vault's equity is its cash plus that realised PnL while its token balance is unchanged. A real venue would settle the loss out of margin.
- RiskGuard limits behavior; it does not guarantee strategy quality or prevent losses inside the mandate.
- A withdrawal needs a mark inside the vault's `maxMarkAgeSeconds`. Redeeming against a price nobody can vouch for would hand the difference to whoever stays, so the vault refuses rather than guesses. No agent, operator or freeze can hold a withdrawal - only a stale mark can, and only until it refreshes. If the feed stays dead, anyone can freeze the vault after three mark ages (`freezeUnobservable()`), and then `withdrawUnpriced()` pays an allocator their share of the vault's cash, capped at the share's worth at the last mark, while their part of the open position stays with those who remain.
- A vault is permanently bound to the adapter it was constructed with. There is no venue migration path.
- The Perpl adapter does not model Perpl's own liquidation, and cannot unwind while Perpl's mark is stale, because Perpl then refuses orders; the cash-only exit above is what an allocator has meanwhile. Funding is counted as Perpl reports it. On testnet it has run one round trip (allocate 150 aUSD, open and close 0.001 BTC, withdraw) and three short runs of a rule-based agent script, about 1.5 hours in all: 10 orders filled and 5 orders past the $200 position cap were refused on chain. That is not sustained trading. Details in [`docs/perpl-adapter.md`](docs/perpl-adapter.md).
- Nothing here has had an external audit. The reviews in this repository are internal.
- Threats, what stops each one and what is left, and what each part's failure costs, are tabulated in [`docs/threat-model.md`](docs/threat-model.md).
- One vault with a stale mark or in `Frozen` state reverts the whole epoch in `BatchAllocator.settleEpoch()`, since settlement allocates to every vault in a single transaction. The batcher has to leave such vaults out of the batch.
- The first deposit into a vault permanently locks `MIN_SHARES` (1e3 share units) to a dead address so a first depositor cannot inflate the share price against later allocators. The first depositor pays that dust.
- `poke()` pays its bounty out of the vault, so a breach costs allocators 0.05% on top of the drawdown, and each of the five `unwind()` steps costs another 0.01%. That is the price of not needing a trusted keeper.
- `unwind()` closes at whatever the venue fills inside a 1% bound of its own mark. In a gap or a thin book the realised loss lands past `maxDrawdownBps`; the term bounds when liquidation starts, not where it ends. If the venue cannot fill inside the bound the step reverts and the position stays open until it can.
- Locked terms cannot be amended, not even to tighten them; different terms mean a new vault. The lock covers the limits and the adapter allowlist, not the venue's price source. An owner who never calls `lockTerms()` has a vault nobody can deposit into.
- On a testnet deployment the venue price comes from the deployer's keeper script, so the mark is only as honest as that keeper. A production venue would supply its own price.
- The live demo signs for its visitors. Nobody installs a wallet: the server holds six testnet-only keys derived from one mnemonic (an allocator, four agents, a keeper) and signs the browser's `eth_sendTransaction` on their behalf, so anyone with the URL is spending the operator's testnet gas. The proxy limits the damage - each key may only call the functions its role is allowed on the contracts it was deployed with, no value transfers, a gas cap per transaction, a global rate limit, and a reset that only the operator's token can trigger - but it is a demo convenience, not a custody model. The contracts never see the proxy; the same book works with a real wallet against the same addresses.
- The live oracle is a transaction per mark. While a browser is open it re-marks the venue every 5 seconds (plus `observe()` every 60 seconds), and backs off to one mark every `ORACLE_IDLE_SECONDS` when nobody is watching (300 by default, 3600 on the hosted demo). Tight Mandate's mark-age term is therefore 10 seconds on a live chain instead of the local 4 seconds, and a page opened after an idle stretch can show `MarkTooOld` for one beat until the oracle notices it. The execution feed only scans the last 90 blocks on load, so a fresh page starts almost empty on a chain that has been running for a while.
- The volatility estimate starts at zero. A freshly deployed vault, or one whose window has fully decayed, is not stress-tested until the tape moves; the clause protects against a spike that has already begun, not the first print of it.
- The estimate is only as good as its sampling. It only sees the marks that reach the guard, so a mark series nobody observes for an hour is one squared return spread over that hour, and a jump that reverts between two samples is invisible. The demo keeper feeds every mark through `observe()`; a live deployment needs someone to do the same, and Chainlink's realised-volatility feeds solve the same problem with a fixed 10-minute sampling grid.
- "k sigma" assumes returns that are roughly normal at the horizon. Crypto returns are fat-tailed, so a 3-sigma clause is a calibrated cushion, not a probability. The stressed drawdown also treats the move as a straight loss at the order's leverage, ignoring funding, fees and any hedge.
- The clause is a per-order refusal, not a volatility-scaled leverage cap. The agent can keep the exposure it already has, whatever the tape does; only the drawdown term can take it away.
- A withdrawal is capped by the cash the vault holds. Shares are priced at the marked value of the open position, but the vault can only pay out what is not tied up in it; the unpaid part of a claim stays as shares until the agent frees up cash or, after a freeze, until `unwind()` has closed the position.

## Repository layout

```text
contracts/src/          MandateVault, MandateRiskGuard, MandateFactory, MockVenueAdapter, BatchAllocator, MandateRegistry, perpl/ (PerplAdapter), interfaces, mocks
contracts/test-js/      node:test suites against an in-process Hardhat 3 (EDR) chain
contracts/test/         Foundry invariant/fuzz and reentrancy tests
contracts/script/       deploy-demo.mjs (the four-mandate book), deploy.mjs (one vault), keeper.mjs, artifacts.mjs
contracts/tools/        solc compile runner and the EIP-712 / Merkle helper (batch.mjs)
reporter/               DP release computation: clipping, Laplace noise, epsilon ledger, EIP-712 signing, Privacy Simulator
web/                    Market, Agent, Allocate, Batch, Privacy, Launch and Live Risk screens, faucet, demo server, in-process chain (chain.mjs) and live-RPC proxy (live.mjs)
web/deployments/        <chainId>.json written by deploy-demo.mjs; the live server boots from it
deploy/systemd/         unit file for running the live demo on a Linux host
docs/                   Milestone design notes, the 2026-10-04 security review, submission status and form texts (docs/submission/, status notes in Korean)
mandate-v0.3-frontend/  Historical snapshot of an earlier frontend design; not built or served
```

## Roadmap

Done:

1. Vault + deterministic MockVenue + one strict Adapter
2. RiskGuard pre-checks, atomic result validation, mark-to-market drawdown and `poke()` freeze
3. BatchAllocator escrow, settlement, claims and refunds
4. Reduce-only `unwind()` after a freeze (from the 2026-09-23 review): permissionless, bountied, five 20% steps with a slippage bound, `Frozen -> Closed`, `IVenueAdapter.reduce()`
5. Locked terms (from the 2026-09-23 review): one-way `lockTerms()` over the limits and the adapter allowlist, deposits refused until locked, `termsHash` for the UI and a future registry anchor
6. Volatility clause (from the 2026-09-23 review): three more terms in `RiskLimits`, an on-chain realised-volatility estimate fed by every mark the guard sees plus a permissionless `observe()`, and a pre-trade stress test that refuses exposure-adding orders with `StressBreach`. A volatility-scaled leverage cap (`min(maxLeverage, targetVol / sigma)`) was considered and not built: it would shrink the mandate under the agent's feet between orders, and the drawdown term already handles a position the tape has turned against. The stress refusal is the "breaker that rejects rather than freezes" from the review.
7. Invariant/fuzz tests (2026-10-04): Foundry stateful invariant suites for the Vault/RiskGuard/Adapter path and for `MandateRegistry`'s epsilon ledger, plus malicious-ERC20 reentrancy tests. Each suite was checked against a deliberately reintroduced bug to confirm it actually fails before being trusted to pass.
8. Batch flow wired into `web/` (2026-10-04): a Batch screen covers escrow, EIP-712 intent signing, on-demand settlement and Merkle-proof claiming end to end, instead of only being exercised by contract tests.
9. `MandateRegistry` and a real `reporter/` module (2026-10-04): the registry anchors agent terms and signed DP releases; the reporter computes and Laplace-noises real statistics over public settlement/trade data and is proven, by an integration test, to produce releases `MandateRegistry.postLeaderboard()` actually accepts. Scoped to public data only — see Privacy model.
10. Published-ε and Privacy Simulator wired into `web/` (2026-10-04): the Privacy screen pools public per-vault NAV returns every price tick, publishes a signed release on click, and re-reads `releaseOf()` from the contract itself to show `VERIFIED ONCHAIN` rather than trusting the server's own report of what it posted. The Simulator slider beside it is pure client-side arithmetic — no fetch, no contract call — using the same scale formula as the real release.
11. Security review (2026-10-04, extended 2026-10-06): Slither static analysis across all of `contracts/src` (45 findings, triaged — 2 fixed, the rest documented as false positives inherent to this codebase's patterns), plus an independent LLM-driven review of the full PR diff. That second pass found a real vulnerability: `MandateRegistry.registerAgent()` took `guard` as a caller-supplied parameter and only checked it for internal self-consistency, so a fake guard contract that answered every check "yes" could permanently squat a real vault's one-time registry slot with fabricated terms. Fixed by reading `guard` from `vault.riskGuard()` directly (no longer a parameter at all) and restricting the call to that guard's owner, since the remaining `fees`/`modelHash` fields have no on-chain ground truth to check. A fourth round on 2026-10-06 applied the same adversarial standard to the marketplace surface merged that day (`MandateFactory`, `TradeTerms`/`FeeTerms` fee minting, `PerplAdapter`/`PerplSubaccount`) — no HIGH or MEDIUM finding cleared the confidence bar. Full writeup: [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md). This is an internal review, not a substitute for an external audit.

Not done:

12. An external, independent security audit. None has been done; the review in item 11 is internal, and an external audit is a prerequisite before any real-money deployment. The live demo is publicly hosted (see [Live testnet demo](#live-testnet-demo)) and the testnet deployment is published under "Recorded run on Monad testnet". A baseline agent is explicitly out of scope (2026-10-04 decision): the protocol's security claims rest on RiskGuard/Vault, not on any particular agent implementation.

From the 2026-09-23 progress review (the reviewers asked what the terms and their ranges are, what happens after a freeze, and how volatility enters). Item 4 above answers "what happens after a freeze", item 5 "can the terms I read change" and item 6 "where does volatility enter"; the rest:

13. Term coverage. Done 2026-10-06, except a reference-price bound: `TradeTerms` adds a market allowlist, direction, limit-price deviation from the mark, trades per day, daily loss and holding time, and `FeeTerms` is now charged by the vault and bound into `termsHash`. Recommended ranges for the eight original terms are not written; the volatility clause's ranges are under "What each term bounds".

Beyond the demo (listed 2026-10-05, when the live demo signed for its visitors with six demo keys and the only agents were the four the deploy script creates):

14. Done and live 2026-10-06. Wallet connection. A visitor signs with their own wallet, gets test mock USDC from a rate-limited faucet, and allocates, signs batch intents, claims and withdraws as themselves. The server keeps signing only for the oracle, the batcher and the reporter.
15. Done and live 2026-10-06. Agent onboarding. An outside operator deploys a vault, sets and locks its terms and registers it from a page. Decided: permissionless, through `MandateFactory` on one canonical guard; the owner only lists adapters. The registry accepts only vaults on the canonical guard, which closes the self-deployed fake-guard gap.
16. Built and verified on a fork 2026-10-06, deployed to testnet the same day and run once through Perpl's exchange ([`docs/perpl-adapter.md`](docs/perpl-adapter.md#testnet-deployment)). A real venue adapter. An `IVenueAdapter` for Perpl, the perp exchange on Monad, in place of MockVenue: orders go to Perpl's testnet contracts and equity is marked at Perpl's mark price, so a mandate bounds real fills, real slippage and a price the operator does not control. Perpl's testnet collateral is not the demo's mock USDC, so the vault's asset becomes Perpl's collateral token.
17. Mainnet with real USDC. Not deployed; it would need item 12's external audit first.

The freeze rules, what happens after a freeze and the structure for more kinds of terms are in [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md) (decided 2026-10-05; the range checks, the unobservable freeze and outcome records are implemented, the rest is design only).

## Stack

Solidity 0.8.37 (EVM `prague`) · Hardhat 3 (EDR) · Foundry (invariant/fuzz) · OpenZeppelin 5.4 · ethers 6 · Node 22+ · dependency-free HTML/JS frontend · Monad testnet.

## Local development

```bash
npm ci
npm run compile
npm run test:contracts
npm run web
```

With [Foundry](https://getfoundry.sh) installed, the invariant/fuzz suite also runs:

```bash
forge install
npm run test:invariant
```

Open `http://localhost:3000` for the interactive demo. Every number on screen is a contract read and every button is a transaction against the in-process chain the server deploys on boot. See [web/README.md](web/README.md) for the screen list and demo interactions.

Use Node 22.14 or newer. After `npm ci`, the local `solc` 0.8.37 runner and the in-process Hardhat tests work without network access. `foundry.toml` configures `contracts/test/`'s stateful invariant suites and reentrancy tests, run with `forge test` (`npm run test:invariant`); the production path is still compiled separately by `contracts/tools/compile.mjs` for Hardhat and the web demo, so Foundry's `via_ir` build flag (needed by one test handler) never affects what ships. CI (`.github/workflows/ci.yml`) runs both suites on every push and pull request, and the Perpl fork test when started by hand with `perpl_fork` checked.

## Live testnet demo

The same screens can run against Monad testnet. A visitor can use the demo allocator, for which the server signs with demo keys it holds and pays the gas, or connect a browser wallet and take test USDC from the faucet. The server deploys the book once. Every number is still a contract read against the live chain, every button still a transaction with an explorer link in the feed.

A public instance runs at <https://mandate-e4kb.onrender.com> (Monad testnet, chain 10143).

```bash
cp .env.example .env        # MONAD_RPC_URL, DEMO_MNEMONIC (testnet-only), DEMO_ADMIN_TOKEN
npm run compile
npm run deploy:demo         # once: deploys and seeds, writes web/deployments/10143.json, prints the address table
npm run web:live            # serves the page, runs the oracle, signs on visitors' behalf
```

Both scripts read `.env` through `node --env-file-if-exists`, so nothing has to be exported by hand. Account 0 of the mnemonic deploys and pays: an estimated 1.8 MON for the deploy and seeding at the testnet's gas price of about 100 gwei (about 18M gas now that the book includes the batch allocator and the registry; the 2026-10-04 run, before those two contracts were part of it, measured 1.25 MON), plus 0.4 MON sent to each of the six demo accounts. `deploy:demo` refuses to start with less than 4.5 MON. Accounts 1 to 5 and 9 are the allocator, the four agents and the keeper; the server signs with those six and never with account 0. The deployment file is meant to be committed for a real network (`web/deployments/31337.json`, a local rehearsal, is ignored).

What the visitor gets:

- The header names the network, and every feed entry links to the transaction on monadscan.
- Allocate, order, poke and unwind buttons work as on the local chain. With the demo allocator chosen under Connect, the server signs `approve`/`allocate`/`withdraw` as the allocator; a browser wallet signs its own. The server signs `execute` as the selected vault's agent, and `poke`/`unwind` as whichever account the page has adopted (the demo allocator once it is chosen, the keeper before that).
- The block-cadence toggle is gone (the chain's cadence is its own) and `Reset demo` only appears when the page is opened with `?admin=<DEMO_ADMIN_TOKEN>`.
- The note under the control room reports the oracle's current cadence, how many marks it has pushed and the gas spent so far.
- Batch and Privacy run on a book deployed with the batch allocator and the registry, which every `deploy:demo` since 2026-10-04 produces; on an older record the two tabs are hidden. The server is the batcher and the reporter: it signs the allocator's `AllocationIntent` when the page asks for an EIP-712 signature, queues it, nets the epoch into one `settleEpoch()`, and posts a DP release with `postLeaderboard()`.

How the server keeps itself safe on a public URL:

- Allowlist per role. A request to sign is refused unless the `from` account is one of the six demo keys, the target is a contract from the deployment, the selector is in that role's list (the allocator may not `execute`, an agent may not `withdraw`), and no value is attached. Refusals come back as JSON-RPC errors the page prints.
- Gas cap (`MAX_GAS_PER_TX`, 1.5M) after a server-side estimate, so a reverting call costs nothing and a runaway one is not signed. The signed limit is the estimate plus `GAS_HEADROOM_PERCENT` (50): an oracle mark that lands between the estimate and inclusion makes `poke()` and `execute()` write more than was estimated, and Monad bills the limit whether or not it is used, so a transaction signed at the bare estimate can run out of gas and still be paid for in full. Reverts surface with their custom-error data, so the page decodes `LeverageExceeded`, `StressBreach` and friends exactly as it does locally.
- Rate limits: `SEND_TX_PER_MINUTE` (40) signed transactions and `CONTROL_PER_MINUTE` (12) shocks per minute across all visitors. Read methods are forwarded to the upstream RPC from a short allowlist; anything else (`evm_mine`, `eth_sign`, ...) is `-32601`. Every visitor's reads share the server's upstream quota, and that quota is small: the public testnet RPC answers 15 `eth_call` a second per IP (measured 2026-10-04) while one page refresh is 32 to 34 reads, and inside a batch it refuses the surplus entry by entry under HTTP 200, where a client's ordinary 429 retry never sees it. So the proxy folds a batch's plain reads into one Multicall3 `aggregate3` call (`PACK_READS`, used when the chain has Multicall3 at its canonical address), resends whatever was refused for rate after a short pause, and answers identical reads from a `READ_CACHE_MS` (2000) cache that the server clears whenever it signs, marks or sees a receipt go by. None of the contracts' views depend on `msg.sender`, so a bundled read returns what a direct one would.
- Typed data. `eth_signTypedData_v4` is answered for one request only: an `AllocationIntent` from the allocator, in the EIP-712 domain of this deployment's batch allocator, for a vault of this book. Any other signer, domain, primary type or field list is refused, so the proxy cannot be made to sign a permit or an order for another contract.
- Batcher and reporter (`web/live-desks.mjs`). `settleEpoch()` reverts as a whole when one intent is stale and the deployer pays for what reaches the chain, so an intent is checked when it arrives (signature, epoch still settleable, nonce neither used nor queued, vault `Active`, escrow covering everything queued) and again right before settlement. A batch that would still revert is taken apart with one `eth_call` per intent and settled without the intents that sink it. Nothing is sent that did not pass a gas estimate. One settlement is capped at `SETTLE_MAX_GAS` (2M), an epoch takes `BATCH_MAX_PER_EPOCH` (8) intents and the queue `BATCH_MAX_PENDING` (32), settlements are limited to `SETTLE_PER_MINUTE` (3) and releases to one every `REPORT_MIN_SECONDS` (120), and the two together draw on `DESK_GAS_PER_HOUR` (10M) of signed gas, about 1 MON at 100 gwei. A release's noise is seeded from `DEMO_REPORTER_SECRET`, or from a random value drawn at boot; it is never derived from a signing key. The queue, the claim proofs and the reporter's samples live in memory and are dropped by a restart or a reset.
- Server. Only the page's own five files are served; every other path is 404. HTML carries a CSP that allows scripts from the page's origin only. Each client IP gets `RPC_IP_PER_MINUTE` (1200) `/rpc` calls and `CONTROL_IP_PER_MINUTE` (30) control posts a minute, on top of the shared limits above. A malformed body is 400, one over 2 MB is 413, and an unexpected failure is answered as `internal error` and logged on the server. `LOG_REQUESTS=1` logs every request; 5xx answers are always logged.
- Faucet. `POST /api/faucet` mints 10,000 test USDC to a connected wallet, once per address per day and `FAUCET_PER_IP` (3) times per client IP per day. With `FAUCET_NATIVE_WEI` set, it also sends that much MON for gas, from the deployer. On a book deployed before 2026-10-06 the faucet answers 404, because those contracts have no factory to go with it.
- Presence-aware oracle. A visitor makes the server mark every `ORACLE_ACTIVE_SECONDS` (5) and `observe()` every `ORACLE_OBSERVE_SECONDS` (60); `PRESENCE_SECONDS` (60) after the last request it drops to `ORACLE_IDLE_SECONDS` (300; the hosted demo sets 3600). A shock lands on the next beat, so the price moves within seconds either way.
- Gas for the demo accounts. Each of the six starts with `DEMO_GAS_PER_ACCOUNT_MON` (0.4). When one drops under `DEMO_GAS_FLOOR_MON` (0.2) the deployer fills it back up, within `DEMO_TOPUP_PER_HOUR_MON` (6) an hour so a visitor hammering the buttons cannot drain it, and never below its own `OWNER_RESERVE_MON` (1) so the oracle keeps marking. `/api/control` reports what has been refilled and says so when an account is low and cannot be.
- Reset policy. `Reset demo` needs the admin token and respects `RESET_COOLDOWN_SECONDS` (600). With `AUTO_RESET` on (default), the server also redeploys by itself when a visitor arrives or leaves and at least `AUTO_RESET_MIN_FROZEN` (2; the hosted demo sets 1, so the vault a judge closes is replaced for the next visitor) vaults are no longer `Active`, provided the deployer still holds `RESET_MIN_BALANCE_MON` (3). Each redeploy is a fresh book at new addresses; the page follows automatically.
- Boot on the newest book (`web/live-recover.mjs`). A redeploy's record is written to the server's disk, and a host that wipes it on restart brings the server back on the committed `web/deployments/<chainId>.json`, which can name an older, frozen book; the next visitor to leave would then trigger another redeploy. Before it starts, the live server walks the deployer's contract-creation addresses down from its current nonce, rebuilds the newest complete book from the links between its contracts (registry and batch allocator owned by the deployer, vaults run by the record's agents, each naming the same USDC, guard and adapter) and boots on that instead. It only reads, at most 12 requests a second because Monad's public endpoint caps `eth_call` at 15, so boot takes up to about a minute longer. `RECOVER_BOOK=0` turns it off.

`deploy/systemd/mandate-web.service` runs it on a Linux host (`/opt/mandate`, a dedicated user, `.env` at mode 600); put a TLS reverse proxy in front of port 3000. The budget for ten days of judging traffic is on the order of 20-30 testnet MON. Rehearse the whole thing offline first with `npx hardhat node` and `MONAD_RPC_URL=http://127.0.0.1:8545`; the proxy, the oracle and the reset path behave the same, only the explorer links are missing.

### Recorded run on Monad testnet

The book below was deployed to Monad testnet (chain 10143) by `0xFCb12322Cd13e5aC40155a46CA6D353625B97684` on 2026-10-06 04:18 UTC and is the one the hosted demo is currently running. It is the first book with the marketplace contracts: `MandateFactory` for permissionless registration, trade terms and fees enforced by the guard and vault, and several markets per venue, on top of the 2026-10-05 freeze rules (see [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md)). Vaults that anyone launches through the factory are listed by `MandateFactory.vaultsFrom()` rather than in this table. It supersedes the earlier books on older contracts, the last of them the 2026-10-05 09:47 UTC book, and the 2026-10-04 book the walkthrough below was recorded against. A restart finds the newest book on chain by walking the owner's own transaction history rather than trusting a committed file, so it does not redeploy on its own.

| Contract | Address |
| --- | --- |
| MockUSDC | [`0xf30eBc7C2F74A1eA0270Ab4f05AA7D267Ad16Fc2`](https://testnet.monadscan.com/address/0xf30eBc7C2F74A1eA0270Ab4f05AA7D267Ad16Fc2) |
| MandateRiskGuard | [`0xB0A208f93532457bF3293C961ed140E07C0aaC80`](https://testnet.monadscan.com/address/0xB0A208f93532457bF3293C961ed140E07C0aaC80) |
| DeterministicMockVenue | [`0x58fc4454Ac11ABA5AdE06bb0d76A54a6dB5fa7eA`](https://testnet.monadscan.com/address/0x58fc4454Ac11ABA5AdE06bb0d76A54a6dB5fa7eA) |
| MockVenueAdapter | [`0xB837E7E85134b1e2897725be30c0A95E3f1B6E0e`](https://testnet.monadscan.com/address/0xB837E7E85134b1e2897725be30c0A95E3f1B6E0e) |
| MandateFactory | [`0xa616314B13C636e728D705bcd2EcE867398B8Fa0`](https://testnet.monadscan.com/address/0xa616314B13C636e728D705bcd2EcE867398B8Fa0) |
| MandateVault · Steady Basis | [`0x2597755019aa8cA237BEF67cb9d2D3e296a978ff`](https://testnet.monadscan.com/address/0x2597755019aa8cA237BEF67cb9d2D3e296a978ff) |
| MandateVault · Range Carry | [`0xF9343F59e7922387039F8b3A907e340FD35EB71b`](https://testnet.monadscan.com/address/0xF9343F59e7922387039F8b3A907e340FD35EB71b) |
| MandateVault · Momentum Vector | [`0xdb1f4bDA5f1885f2e1Fe86e77474C7A9E4358412`](https://testnet.monadscan.com/address/0xdb1f4bDA5f1885f2e1Fe86e77474C7A9E4358412) |
| MandateVault · Tight Mandate | [`0xac0B02595ccc91d44D44cdD338629815E3413904`](https://testnet.monadscan.com/address/0xac0B02595ccc91d44D44cdD338629815E3413904) |
| BatchAllocator | [`0x55B082EC7c04daF546bCb9b91C07c02680fd601E`](https://testnet.monadscan.com/address/0x55B082EC7c04daF546bCb9b91C07c02680fd601E) |
| MandateRegistry | [`0x431fd7097dBfa2808270D9de9f7A0ceF136d1435`](https://testnet.monadscan.com/address/0x431fd7097dBfa2808270D9de9f7A0ceF136d1435) |

The walkthrough below predates this table: it was recorded against the 2026-10-04 predecessor book, before that book was replaced by the restarts described above. The addresses it names are no longer live, but the mechanisms it exercised (order limits, price-shock freeze, frozen-vault rejection, `unwind()`) are the same contract code running in the book above, so the run is kept as evidence of behavior rather than of these specific addresses.

One pass through the demo against that earlier book, every step sent through the page's `/rpc` proxy and signed by the server's demo keys:

| Step | What the chain did | Transaction |
| --- | --- | --- |
| Allocator approves and deposits 1,000 mUSDC into Steady Basis | mined | [`0x0ee552ec…9c1451`](https://testnet.monadscan.com/tx/0x0ee552ec365ba07f6756aa8fb0c535645cf9d5843809e1a372d950ee6a9c1451), [`0x0051d60b…30a3cb`](https://testnet.monadscan.com/tx/0x0051d60b98de1e9873b6ca615c10d038cb8c131f04a1705a16bcd191b830a3cb) |
| Agent sends an order of 1,000 units, far past the order limit | refused with `OrderNotionalExceeded` at the server's estimate | none, nothing was signed |
| Agent sends an order inside the mandate (Steady Basis, then Tight Mandate) | mined | [`0x3452ae43…cb8dcb`](https://testnet.monadscan.com/tx/0x3452ae43a0cef718f10787b695247d4d13522496e8fbaa2df8a7529395cb8dcb), [`0x5f63aed9…950f06`](https://testnet.monadscan.com/tx/0x5f63aed932f5e972273ef42bf0b5f52f99da5aed750fd4f95251d25bbf950f06) |
| Oracle marks the venue 10% lower | price 2001.40 to 1801.26, on chain 4.5 s after the click | the server's own `setPrice` |
| `poke()` on Steady Basis | mined, vault stays `Active` | [`0x83eb5e38…d58ca0`](https://testnet.monadscan.com/tx/0x83eb5e38ace6e7be44bb785062e7ee69c58dd83851a5bd4e92fc19699dd58ca0) |
| `poke()` on Range Carry, Momentum Vector, Tight Mandate | mined, each vault goes `Frozen` | [`0x2570b23e…967ed8`](https://testnet.monadscan.com/tx/0x2570b23e2409a76318fced788bd2101fba33c8e700d2076ac34e6d8e17967ed8), [`0xfe156591…186d52`](https://testnet.monadscan.com/tx/0xfe156591ee120b8333f23d3bfb3db06515c6b2ad9fe1677af5c124114f186d52), [`0x790d52d2…08b50e`](https://testnet.monadscan.com/tx/0x790d52d27e3d63e56c3173b320ac4e1db6ccdf4b01e6966eef055e383708b50e) |
| Agent sends an order on frozen Range Carry | refused with `AgentNotActive` | none, nothing was signed |
| `unwind()` step 1 of 5 on Range Carry | mined, a fifth of the position closed | [`0x598d53b5…1f5e16`](https://testnet.monadscan.com/tx/0x598d53b5f45845f07a1178d83c6a63926e5af8dc246d9fc7d29dbc8fcb1f5e16) |

Each transaction was confirmed 1.1 to 1.6 seconds after the request reached the server. In the same session eight consecutive `poke()` calls on Tight Mandate, 5 to 7 seconds apart by block timestamp on a quiet market, all passed its 10-second mark-age term; not one reverted with `MarkTooOld`. The table gives the age of the mark each call was checked against: the call's block timestamp minus the venue's `updatedAt` from the last `PriceSet` before it, read back from the chain (`eth_getLogs` and block headers on the public RPC). The ages run from 1 to 5 seconds, which is the 5-second oracle interval; the block interval adds under a second. Over the 8 calls: median 3 s, maximum 5 s, against the 10-second term. Eight calls on a quiet market are a sample, not a distribution; they show the term can be honored, not how often it fails under load.

| Block | `poke()` | Mark age at execution |
| --- | --- | --- |
| 68074867 | [`0x04217deb…ce6862`](https://testnet.monadscan.com/tx/0x04217deb6002384253131ed497b4cfc4da86bdd78842e74885508852c8ce6862) | 2 s |
| 68074886 | [`0xf2617986…8141bb`](https://testnet.monadscan.com/tx/0xf26179867945cbad50ed85d0fa0c41bbd114ef6fc52eb8a8eb9516b43d8141bb) | 3 s |
| 68074905 | [`0x5a78cef3…13a2c2`](https://testnet.monadscan.com/tx/0x5a78cef33f55e2eb871657da8594a86c0a2f6aebfe68c75e8f0b9cc6a813a2c2) | 3 s |
| 68074924 | [`0xd5918f46…78c766`](https://testnet.monadscan.com/tx/0xd5918f46829a0a6e743d0663382e8dae94cf35e471252b48ee513494ae78c766) | 4 s |
| 68074942 | [`0x0c09903a…0b9fb5`](https://testnet.monadscan.com/tx/0x0c09903ab50859705038278642e86c962dbab0c801070314e34e98306c0b9fb5) | 5 s |
| 68074963 | [`0xdf5f731c…57f3a4`](https://testnet.monadscan.com/tx/0xdf5f731c81fd3aaa9a5688fd57840b3512c51ca59a644ee0d0ae7d7d4657f3a4) | 1 s |
| 68074981 | [`0x6b5274a4…9d5b90`](https://testnet.monadscan.com/tx/0x6b5274a4df14d83f08081061af22cf1af01e72c1b36b96e7905eca96f89d5b90) | 1 s |
| 68075001 | [`0x4cbbb5ba…ff068b`](https://testnet.monadscan.com/tx/0x4cbbb5ba9629650e9c2dbea9e627b9e217705f2945c3ebc2965a8aca72ff068b) | 3 s |

## Deploying to a live RPC

Network values are supplied through environment variables instead of being hardcoded because the testnet may be reset. `deploy:demo` above is the deployment the demo serves; `deploy:monad` is the single-vault alternative for pointing a wallet or a bot at one mandate without the demo server.

```bash
cp .env.example .env        # MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, AGENT_ADDRESS
npm run compile
npm run deploy:monad        # one vault + BatchAllocator, writes contracts/deployments.latest.json
npm run keeper:monad        # keeps the venue price fresh and calls poke() on every vault it finds
```

The single-vault deploy configures the vault with `maxMarkAgeSeconds = 30` and locks its terms in the same run, so without a keeper every `execute`, `allocate` and `withdraw` starts reverting with `MarkTooOld` thirty seconds after deployment. The keeper walks the mock price inside a band and serves every vault in the deployment file it finds (`contracts/deployments.latest.json` first, then `web/deployments/<chainId>.json`, or `DEPLOYMENT_FILE`): `poke()` while a vault is `Active`, `observe()` once it is not, so a drawdown breach is caught and the volatility estimate stays fed. It accepts `DEPLOYER_PRIVATE_KEY` or `DEMO_MNEMONIC` (account 0), whichever owns the venue. Do not run it next to `web:live` on the same deployment: two oracles from one key fight over nonces. Never commit a private key or the mnemonic; `.env` is ignored.

See `mandate-technical-spec-v0.2.md` for interfaces, state transitions, privacy boundaries and test requirements. The spec predates the mark-to-market guard; sections that changed carry an implementation note.

## AI tool disclosure

AI coding tools were used to build this repository, and the rules of Monad Metropolis ask for that to be stated. Commits that carry a `Co-Authored-By: Claude …` trailer were written with Claude Code (Anthropic's CLI, models Claude Fable 5.1, Claude Opus 5, Claude Opus 5.5 and Claude Sonnet 5) under the committer's direction. They touch the contracts, the tests, the deploy scripts, the demo server and page, and this README; `git log` shows which commits those are. The eight earlier commits without a trailer (2026-09-20 to 09-22) were also written with AI coding tools, mostly Claude. The team set the design and the requirements and decided what was merged.

## Third-party code

- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) 5.4.0 (MIT): `ERC20`, `IERC20`, `SafeERC20`, `ReentrancyGuard`, `Ownable`, `EIP712`, `ECDSA`, `MerkleProof`, `Math`, imported unmodified from the npm package.
- [Hardhat](https://github.com/NomicFoundation/hardhat) 3 (MIT), [ethers](https://github.com/ethers-io/ethers.js) 6 (MIT) and [solc-js](https://github.com/ethereum/solc-js) 0.8.37 (MIT) as development dependencies.
- [Multicall3](https://github.com/mds1/multicall3) (MIT) is not vendored; the live server calls the canonical deployment at `0xcA11bde05977b3631167028862bE2a173976CA11` to bundle reads.
- The page loads the Manrope and DM Mono typefaces from Google Fonts (SIL Open Font License).

## License

MIT. See [LICENSE](LICENSE).

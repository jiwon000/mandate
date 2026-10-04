# Mandate 기술명세서

버전 0.2 · Monad Metropolis Track 1 · v1 구현 기준

2026-09-22 정정: 구현과 달라진 절에는 `[구현 기준 2026-09-22]` 표기를 달았다. 문서와 코드가 다르면 코드가 우선한다.

## 1. 제품 정의

Mandate는 자율 트레이딩 에이전트에게 인출 권한 없이 제한된 실행 권한만 부여하고, 배분자가 에이전트의 검증 가능한 성과와 리스크 상태를 보고 자본을 배분하는 라이브 온체인 시장이다.

v1의 핵심은 다음 세 가지다.

1. `MandateVault + RiskGuard`: 자금 보관, 지분 회계, 실행 권한 및 리스크 강제
2. `BatchAllocator`: 여러 사용자의 배분 의도를 모아 에폭 단위로 순액만 볼트에 반영
3. `DP Reporter`: 공개되지 않은 관심 신호와 배분 의도를 DP 집계하고, 성과 통계와 누적 ε를 앵커

DP는 자금 안전을 담당하지 않는다. 공개 체인의 원거래를 지우거나 숨긴다고 주장하지 않으며, 표시 통계와 비공개 intent 집계에만 적용한다.

## 2. 시스템 아키텍처

```text
Allocator ──signed intent──> Intent API ──epoch batch──> BatchAllocator ──net allocation──> Vault
                                  │                            │
                                  └─ private raw intents       └─ public batch settlement
                                             │
                                             ▼
                                    DP Reporter
                              watchlist / intent aggregates
                              performance CI / ε accounting
                                             │
                                  signed digest + cumulative ε
                                             ▼
Agent ──execution request──> MandateVault ──> VenueAdapter ──> MockVenue
                                  │               │
                                  └── RiskGuard pre-check
                                             │
                                             ▼
                                     MandateRegistry
```

### 신뢰 경계

- 자금, 지분, 권한, 주문 한도 및 상태 전이는 온체인에서 강제한다.
- watchlist와 정산 전 intent는 Reporter 입력으로만 쓴다. 단 정산에 포함된 intent와 서명은 settlement calldata로 공개된다 (3.6, `docs/batch-allocator-milestone2.md`).
- `BatchAllocator`는 공개된 개별 전송을 완전히 익명화하지 않는다. 동일 에폭의 요청을 합쳐 에이전트별 순액을 정산해 직접적인 `allocator → agent vault` 연결을 줄이는 역할이다.
- 체인 분석으로 드러나는 입출금 정보를 DP가 숨긴다고 주장하지 않는다.
- Reporter 침해는 표시 통계와 비공개 intent 정보에 영향을 주지만 Vault 자금 이동 권한을 주지 않는다.

## 3. 온체인 컴포넌트

### 3.1 공통 타입

```solidity
enum AgentState { Active, Frozen, Closed }

struct RiskLimits {
    uint16 maxLeverageX100;
    uint16 maxDrawdownBps;        // mark-to-market, 고점 NAV/share 대비 bps
    uint32 minBlocksBetweenTrades;
    uint32 maxMarkAgeSeconds;     // 이보다 오래된 mark로는 거래·예치·인출 불가. 0 = 비활성
    uint256 maxOrderNotional;
    uint256 maxPositionNotional;
    uint256 maxTotalNotional;
    uint256 maxBlockNotional;
    uint32 volWindowSeconds;      // 실현 변동성 추정치의 기억 길이(초). 0 = 변동성 조항 없음
    uint32 stressHorizonSeconds;  // 스트레스 이동을 잡는 기간(초)
    uint16 stressSigmasX10;       // 견뎌야 하는 이동, 0.1 sigma 단위 (30 = 3 sigma)
}
```

세 변동성 필드는 뒤에 붙였다. `termsHash`가 필드 순서대로의 `abi.encode`이므로 순서를 바꾸면 기존 해시가 깨진다. `configure()`는 `volWindowSeconds != 0`인데 horizon이나 sigma가 0이면 `InvalidStressTerms`로 거부한다.

```solidity

struct FeeTerms {
    uint16 perfFeeBps;
    uint16 protocolFeeBps;
}
```

[구현 기준 2026-09-22] `maxRealizedDrawdownBps`·`maxSlippageBps`·`maxConsecutiveRejects`는 제거했다. drawdown은 3.5의 mark 가격 기준 mark-to-market으로 검사하고, 거부 횟수 기반 동결은 3.4의 `poke()`로 대체했다. `FeeTerms`는 아직 구현되지 않았다.

### 3.2 MandateVault

에이전트별 비수탁 볼트다. Allocator 또는 승인된 `BatchAllocator`가 USDC를 예치하고 지분을 받는다. 에이전트는 등록된 `VenueAdapter`를 통한 거래만 요청할 수 있고 자금 인출·임의 전송은 할 수 없다.

```solidity
interface IMandateVault {
    event Allocated(address indexed receiver, uint256 assets, uint256 shares);
    event Withdrawn(address indexed owner, uint256 assets, uint256 shares);
    event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl);
    event PerfFeeAccrued(uint256 amount, uint256 highWater);

    /// RiskGuard에서 조건이 잠기기 전에는 TermsNotLocked로 revert한다 (3.4의 7번).
    function allocate(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 shares, address receiver) external returns (uint256 assets);
    function execute(address adapter, bytes calldata order) external;
    /// 동결된 vault의 포지션을 누구나 5단계로 줄인다. 다 줄이면 Closed.
    function unwind() external returns (bool closed);
}
```

Vault는 임의 `(venue, selector)` 호출을 지원하지 않는다. Registry에 등록된 전용 Adapter만 호출하며 `transfer`, `approve`, `withdraw` 계열 calldata를 에이전트가 직접 구성할 수 없다.

### 3.3 VenueAdapter

Adapter는 외부 venue마다 주문 해석, 예상 상태 계산, 안전한 외부 호출 및 결과 검증을 캡슐화한다.

```solidity
interface IVenueAdapter {
    struct Preview {
        uint256 orderNotional;
        uint256 expectedPositionNotional;
        uint256 expectedTotalNotional;
        uint256 expectedLeverageX100;
        uint256 minAmountOut;
        bytes32 orderHash;
    }

    function preview(address vault, bytes calldata order)
        external view returns (Preview memory);

    function execute(address vault, bytes calldata order)
        external returns (int256 realizedPnl, uint256 amountOut);

    function positionState(address vault)
        external view returns (uint256 positionNotional, uint256 totalNotional);

    /// 현재 포지션의 fractionBps만큼을 reduce-only로 닫는다. vault만 호출한다.
    /// 어댑터가 보이는 포지션에서 닫는 주문을 만들므로 호출자는 venue 단위·방향을 몰라도 된다.
    /// mark 대비 슬리피지 상한(mock: 1%)보다 나쁜 체결은 revert한다.
    function reduce(address vault, uint16 fractionBps)
        external returns (uint256 closedNotional, int256 realizedPnl);

    /// 현금 + 미실현 손익을 venue 가격으로 평가한 지분 가치. markedAt은 venue의 가격 시각.
    function markEquity(address vault)
        external view returns (uint256 equity, uint256 markedAt);
}
```

Adapter 승인 조건:

- 주문 calldata를 완전히 해석할 수 있어야 한다.
- 예상 노셔널·포지션·최소수령량을 사전 계산할 수 있어야 한다.
- 외부 호출 전체가 EVM 트랜잭션 안에서 원자적으로 성공 또는 revert되어야 한다.
- 임의 토큰 승인과 callback을 금지하거나 명시적으로 검증해야 한다.
- 원자적 롤백을 보장하지 않는 venue는 v1에서 허용하지 않는다.

### 3.4 RiskGuard 상태 전이

정상 한도 위반은 외부 호출 전에 처리한다.

```text
execute request
  → adapter.preview(order)
  → RiskGuard.checkAndConsumeBefore(vault, adapter, preview)
      ├─ violation: revert (외부 거래 없음)
      └─ pass: adapter.execute(...)
                   → validate amountOut / resulting state
                       ├─ mismatch: whole transaction reverts atomically
                       └─ valid: RiskGuard.checkAfter(vault, adapter)
                                   → adapter.markEquity 로 NAV/share 재평가
                                   → 고점(high-water) 갱신, drawdown·mark age 검사
                                       ├─ 한도 초과: vault.freeze() + 이벤트
                                       └─ 정상: accounting update and event
```

`revert`된 트랜잭션 안에서는 `Frozen` 상태를 기록할 수 없다. 그래서 거부된 주문은 동결의 근거가 아니다. 동결은 mark 가격 기준 상태 검사로만 일어난다.

1. 단일 한도 위반: 거래만 revert한다. 카운트하지 않는다.
2. 거래 후 검사: 성공한 모든 거래 뒤에 `checkAfter`가 NAV/share를 재평가하고 drawdown을 검사한다.
3. 거래 사이의 검사: 누구나 `MandateRiskGuard.poke(vault, adapter)`를 호출할 수 있다. NAV/share가 고점 대비 `maxDrawdownBps`보다 더 떨어져 있으면 vault를 `Frozen`으로 전환하고, vault가 호출자에게 자산의 `POKE_BOUNTY_BPS`(0.05%)를 바운티로 지급한다. 신뢰된 keeper가 필요 없다.
4. mark age: `block.timestamp > markedAt + maxMarkAgeSeconds`이면 execute·allocate·withdraw·poke 모두 `MarkTooOld`로 revert한다. mark가 갱신되면 풀린다.
5. Frozen 상태: 신규 execute/allocate는 차단하고 allocator withdrawal과 `transferShares`는 유지한다.
6. Frozen 이후 청산 [구현 기준 2026-09-23]: 동결은 에이전트를 멈출 뿐 포지션을 닫지 않으므로 손실은 계속 커질 수 있다. 누구나 `MandateVault.unwind()`를 호출할 수 있다. 한 번 호출할 때마다 어댑터의 `reduce()`로 동결 시점 크기의 1/5을 reduce-only로 닫고(잔여분의 2000·2500·3333·5000·10000 bps 순, 마지막은 전량), venue mark 대비 `MAX_UNWIND_SLIPPAGE_BPS`(1%) 안에서만 체결하며, 호출자에게 현금의 `UNWIND_BOUNTY_BPS`(0.01%)를 지급한다. 블록당 한 단계(`UnwindCooldown`). 포지션이 0이 되면 `Frozen -> Closed`로 전이하고 `Closed` 이벤트를 낸다. Closed에서는 execute·allocate·unwind가 모두 revert하고, withdraw는 mark age 검사를 건너뛴다(포지션이 없으니 가격이 지분 가치를 바꾸지 못한다). Hyperliquid가 인출 증거금 부족 시 20%씩 닫는 방식을 따랐다.
7. 조건 잠금 [구현 기준 2026-09-23]: `MandateRiskGuard.lockTerms(vault)`는 owner만 부를 수 있고 되돌릴 수 없다. 잠긴 뒤에는 `configure()`와 `setAdapter()`가 `LimitsLocked`로 revert하고, 잠기기 전에는 `MandateVault.allocate()`가 `TermsNotLocked`로 revert한다. 돈은 owner가 더는 고칠 수 없는 조건 뒤로만 들어간다. `termsHash(vault)`는 `RiskLimits`를 필드 순서대로 `abi.encode`한 keccak256이고 `TermsLocked(vault, termsHash)` 이벤트에 실린다. timelock이나 수정 경로는 없다. 조건이 다르면 새 vault다. 3.7 Registry release가 생기면 이 해시를 앵커한다.
8. 변동성 조항 [구현 기준 2026-09-23]: guard는 vault마다 `VolState{lastPriceE18, lastPriceAt, varRatePerSecond}`를 둔다. 새 mark가 들어오면(`checkAndConsumeBefore`, `checkAfter`, `poke`, 그리고 누구나 부를 수 있는 `observe(vault, adapter)`) 직전 mark 대비 수익률 `r = |p1 - p0| / p0`(상한 1000%)의 제곱을 경과 초 `dt`로 가중해 `v' = (window * v + r^2) / (window + dt)`로 갱신한다. 첫 mark는 가격만 기록하고, 이미 본 mark(`markedAt <= lastPriceAt`)나 가격 0은 무시한다. 총 노출을 늘리는 주문(`expectedTotalNotional > 현재 totalNotional`)에 한해, `sigmaBps = sqrt(v * stressHorizonSeconds)`, `moveBps = sigmaBps * stressSigmasX10 / 10`, 주문 후 레버리지(`expectedLeverageX100`, 상한 10000x)에서의 손실 `lossBps = lev * moveBps / 100`을 현재 NAV/share에 적용한 값을 `max(고점, 현재)` 대비 drawdown으로 환산해 `maxDrawdownBps`를 넘으면 `StressBreach(sigmaBps, moveBps, stressedDrawdownBps)`로 revert한다. 검사 순서는 레버리지 한도 뒤, 쿨다운·블록 노셔널 앞이다. 줄이는 주문은 검사하지 않고, 어떤 경우에도 동결하지 않는다. `stressQuote(vault, adapter, leverageX100)`는 같은 세 값을 view로 돌려주되 아직 반영 안 된 mark를 투영해서 계산한다(쓰지 않음). `volWindowSeconds = 0`이면 추정치도 검사도 없다. 이 조항은 drawdown 한도를 두 번 집행하는 셈이다: 사후에는 `poke()`와 동결로, 사전에는 지금 테이프가 감당 못 할 노출을 늘리는 주문의 거절로.

[구현 기준 2026-09-22] v0.2의 `recordRejectedOrder`·`maxConsecutiveRejects`·guardian `freezeAgent`·`ExecutionRelay` 경로는 폐기했다. 거부 횟수는 온체인 상태가 아니라 증거 제출 문제를 만들었고, mark-to-market 검사가 같은 목적을 온체인 상태만으로 달성한다.

### 3.5 가격 및 Drawdown 정의

v1 MockVenue는 결정론적 온체인 가격을 제공한다. 데모의 레버리지와 mark-to-market 위험 지표는 이 가격에만 의존한다.

```solidity
// DeterministicMockVenue (v1 구현). 가격과 가격 시각을 함께 공개한다.
uint256 public priceE18;
uint256 public updatedAt;
function setPrice(uint256 newPriceE18) external onlyOwner;

// IVenueAdapter.markEquity: equity = 현금 + 미실현 손익, markedAt = venue.updatedAt
```

- v1: `DeterministicMockVenue`; 시나리오별 가격 변화가 `setPrice` 트랜잭션으로 기록된다. 데모에서는 서버가, 테스트넷에서는 `contracts/script/keeper.mjs`가 가격을 밀어 넣는다.
- `markedAt`은 `block.timestamp`가 아니라 venue의 가격 시각이다. 빠른 체인이 오래된 피드를 새것처럼 보이게 할 수 없다.
- production 확장: TWAP 또는 검증된 oracle, deviation guard 추가. staleness guard는 `maxMarkAgeSeconds`로 이미 온체인에 있다.
- [구현 기준 2026-09-22] drawdown은 항상 mark-to-market이다. mark 없이 강제하는 `realizedDrawdown` 지표는 없다.

정확한 보안 문구:

> Custody and execution permissions are enforced on-chain. Market-value risk limits depend on the configured venue price source; the demo uses a deterministic on-chain mock venue.

### 3.6 BatchAllocator

사용자는 직접 Agent Vault에 예치하는 대신 에폭별 배분 intent에 서명한다.

```solidity
struct AllocationIntent {
    address allocator;
    address vault;
    uint256 amount;
    uint256 minShares;
    uint256 epoch;
    uint256 nonce;
    uint256 deadline;
}

interface IBatchAllocator {
    function depositEscrow(uint256 assets) external;
    function cancelIntent(uint256 nonce) external;
    function settleEpoch(
        uint256 epoch,
        bytes32 intentRoot,
        BatchNetAllocation[] calldata nets
    ) external;
    function withdrawEscrow(uint256 assets) external;
    function claimShares(AllocationIntent calldata intent, bytes32[] calldata proof) external;
}
```

에폭 흐름:

1. 사용자가 USDC를 escrow에 예치한다.
2. UI에서 EIP-712 `AllocationIntent`에 서명한다. 서명 시점에는 온체인에 올라가지 않지만, 정산에 포함된 intent와 서명은 settlement calldata로 공개된다.
3. 에폭 종료 시 batcher가 intent Merkle root와 에이전트별 순배분액을 게시한다.
4. `BatchAllocator`가 각 Vault에 순액을 한 번 예치한다.
5. 사용자는 proof로 자신의 지분을 claim한다.
6. 미체결·만료·취소 intent의 escrow는 환불 가능하다.

v1 중앙화 한계: batcher가 intent를 검열하거나 지연할 수 있다. 자금을 탈취할 수 없도록 escrow 환불 경로와 settlement deadline을 온체인에서 강제한다. 개별 입금 주소와 escrow 입금액은 공개되므로 완전한 allocator 익명성을 보장하지 않는다.

### 3.7 MandateRegistry / DP Anchor

```solidity
interface IMandateRegistry {
    function registerAgent(
        address vault,
        address adapter,
        RiskLimits calldata limits,
        FeeTerms calldata fees,
        bytes32 modelHash
    ) external;

    function postLeaderboard(
        uint256 epoch,
        uint256 pinnedBlock,
        bytes32 statsDigest,
        uint256 epsilonPerfE6,
        uint256 epsilonIntentE6,
        uint256 cumulativeEpsilonE6,
        bytes calldata reporterSig
    ) external;
}
```

epoch와 pinnedBlock은 단조 증가해야 하며 동일 epoch의 digest 교체를 금지한다.

## 4. DP Reporter

### 4.1 DP 보장 범위

| 데이터 | 공개 원본 여부 | v1 표현 |
|---|---|---|
| 체결 및 Vault 상태 | 공개 | DP 보장 없음 |
| escrow 입출금 | 공개 | DP 보장 없음 |
| 에이전트별 batch 순정산액 | 공개 | privacy-aware public analytics |
| 개별 watchlist | 비공개 | DP 집계 보장 대상 |
| 개별 allocation intent | settlement 전 비공개 | DP 집계 보장 대상 |
| 성과 리더보드 | 공개 체결로 근사 가능 | canonical DP/overfit-aware statistic; 완전 은닉 아님 |

`allocation flow DP`라는 표현은 두 종류로 구분한다.

- `Public settlement analytics`: 공개 배치 정산액을 노이즈 집계한 편의 통계. 프라이버시 보장으로 판매하지 않는다.
- `Private demand analytics`: 공개되지 않은 watchlist 및 settlement 전 allocation intent를 DP로 집계한다. 예: 관심 allocator 수, 수요 구간, intent inflow/outflow, conversion rate.

개별 intent 조회 API는 제공하지 않는다. Reporter 입력 로그는 epoch 정산 후 제한된 보존 정책에 따라 삭제한다.

### 4.2 성과 CI

- 거래별 return contribution을 `[-c, c]`로 clipping한다.
- epoch별 mean return, Sharpe, realized/max marked drawdown의 DP 통계를 계산한다.
- 표본 불확실성과 DP 메커니즘의 불확실성을 분리해 CI 메타데이터에 기록한다.
- 체결 공개로 인한 side channel을 UI와 README에 명시한다.

### 4.3 예산 및 결정론

실제 릴리즈 cadence와 ε는 서버 설정으로 고정한다. 동일 데이터 재릴리즈도 composition에 포함한다. 누적 ε 상한을 넘으면 해당 통계 릴리즈를 중단한다.

공개·예측 가능한 고정 시드는 사용하지 않는다.

```text
noiseSeed = HMAC_SHA256(
  reporterSecret,
  domainSeparator || epochId || pinnedBlock || statsVersion
)
```

- 동일 버전의 재계산 결과는 Reporter 내부에서 결정론적이다.
- 외부 사용자는 `statsDigest`, epoch, pinnedBlock, ε 및 reporter signature로 게시 결과의 불변성을 검증한다.
- 외부 사용자가 noise seed나 noise-free statistic을 복원할 수 있다고 주장하지 않는다.
- `statsVersion` 변경은 새로운 릴리즈이며 추가 ε 소비로 처리한다.
- post-hackathon에는 threshold reporter 또는 commit-reveal/VRF 기반 randomness를 검토한다.

### 4.4 UI 분리

- `Published ε`: 해당 epoch에 실제 사용되고 온체인에 앵커된 값. 사용자가 변경할 수 없다.
- `Privacy Simulator`: 합성 데이터에서 ε에 따른 CI 폭과 utility 변화를 보여주는 교육용 도구. 슬라이더 조작은 실제 릴리즈가 아니며 ε를 소비하지 않는다.

Simulator에는 항상 `Synthetic preview — not the published leaderboard` 라벨을 표시한다.

## 5. 데모 에이전트

데모의 에이전트는 스크립트된 주문 시퀀스다. 어떤 에이전트든 같은 Adapter와 RiskGuard를 거치며, 에이전트 정책 자체는 프로토콜의 보안 근거가 아니다. 학습 기반 정책은 이 스펙의 범위 밖이다.

## 6. 핵심 불변식

1. Agent는 allocator 또는 Vault 자금을 직접 인출·전송·승인할 수 없다.
2. 승인되지 않은 Adapter를 통한 외부 호출은 불가능하다.
3. 외부 거래 전에 주문·블록·포지션·총노셔널 한도를 검증한다.
4. Adapter 결과 불일치 시 전체 트랜잭션이 원자적으로 revert된다.
5. Frozen 이후 execute와 신규 allocate는 차단되며 withdraw는 유지된다. `unwind()`는 Frozen에서만 동작하고 포지션을 키우거나 뒤집을 수 없다. Closed는 종착 상태다.
6. 총 발행 shares는 사용자·BatchAllocator claim entitlement와 일치한다.
7. escrow 자산은 정산 또는 deadline 이후 환불만 가능하다.
8. cumulative ε는 단조 증가하고 상한 초과 릴리즈는 거부된다.
9. 동일 epoch/pinnedBlock/statsVersion의 digest는 변경할 수 없다.
10. malicious token/venue callback이 Vault 회계에 reentrancy를 일으킬 수 없다.
11. allocate는 조건이 잠긴 vault에만 들어가고, 잠긴 조건(한도와 adapter allowlist)은 이후 바뀌지 않는다.
12. 변동성 조항은 총 노출을 늘리는 주문만 거절하고 상태를 바꾸지 않는다. 변동성 상태는 mark 시각이 앞으로 갈 때만 갱신되며, 어떤 mark도 두 번 반영되지 않는다.

## 7. 테스트 전략

### Contracts

- Vault share/NAV 및 high-water fee 경계값
- Adapter allowlist 및 calldata 해석
- `preview → checkBefore → execute → validate` 원자성
- 실패 트랜잭션에서 freeze가 저장되지 않는 상태 전이 검증
- 별도 rejection evidence와 freeze 경로
- MockVenue deterministic price, stale/deviation 시나리오
- Batch escrow, nonce, deadline, cancellation, settlement root, claim, refund
- Reentrancy 및 malicious adapter/token fuzzing

### Reporter

- clipping sensitivity와 noise scale
- 동일 domain input에 대한 내부 재현성
- epoch 또는 statsVersion 변경 시 domain separation
- ε composition 단조성 및 budget exhaustion
- 실제 published release와 synthetic simulator의 데이터 경로 분리

### E2E 데모

1. Agent 등록
2. 여러 allocator가 escrow 예치 및 intent 서명
3. watchlist/intent DP 집계 게시
4. 에폭 batch settlement 및 shares claim
5. 정상 주문 체결
6. 과도 주문 사전 revert
7. 반복 거부 증거 제출 후 별도 freeze
8. Published ε와 digest 앵커 확인
9. allocator withdrawal

## 8. v1 비목표 및 한계

- allocator 완전 익명성 또는 shielded transfer
- 일반 외부 venue의 무제한 지원
- 커넥톰 기반 에이전트의 생물학적 충실도 또는 우월성 주장
- Reporter의 탈중앙화
- 메인넷 및 실자금 운용
- 시스템 전역 DP
- 동결 후 청산의 자동 실행. `unwind()`는 누구나 부를 수 있고 바운티가 있지만 스스로 실행되지는 않는다(3.4). 아무도 부르지 않으면 포지션은 열린 채로 남고 인출은 현금 한도 안에서만 된다. mock venue는 실현 손익을 토큰으로 정산하지 않으므로 Closed vault의 지분 가치는 현금 + 실현 손익이고 토큰 잔고는 그대로다.
- 외부 변동성 원천. 변동성은 guard가 자기가 본 mark로 직접 쌓은 분산(3.4의 8번)뿐이다. 외부 변동성 oracle, 옵션 내재변동성, 거래소 증거금 구간은 입력이 아니다. 추정치는 표본을 넣어 주는 만큼만 정확하다: 아무도 `observe()`하지 않는 한 시간은 그 한 시간의 수익률 한 개다.
- 변동성 연동 레버리지 상한(`min(maxLeverage, targetVol / sigma)`). 검토했고 만들지 않았다. 주문 사이에 조건이 에이전트 발밑에서 줄어드는 셈이고, 이미 들고 있는 포지션이 테이프에 밀리는 경우는 drawdown 조항이 맡는다. 변동성 조항은 주문 단위 거절이지 포지션 축소가 아니다.
- 조건 수정 경로. 잠긴 조건은 timelock으로도 바꿀 수 없다(3.4의 7번). 조건을 바꾸려면 새 vault를 띄운다. 잠금은 한도와 adapter allowlist를 덮고 venue 가격 원천은 덮지 않는다. owner가 `lockTerms()`를 부르지 않으면 아무도 예치할 수 없는 vault로 남는다. Registry release 앵커는 3.7이 구현될 때.

## 9. 이후 확장

- TWAP/다중 oracle 및 circuit breaker
- permissionless Adapter audit/registration process
- threshold reporter와 검증 가능한 randomness
- shielded batch funding 또는 privacy pool
- delayed RFQ execution
- RDP accountant와 multi-epoch scheduler

### 2026-09-23 진행 발표 피드백 반영

피드백 요지: 매개변수와 범위가 무엇인지, 한도 위반 시 거절인지 동결인지, 동결 뒤에는 어떻게 되는지, 변동성이 체결 전후 어디에 들어가는지. 현재 동작은 3.4(거절 vs 동결)와 README의 "What each term bounds" 표가 답한다. 아래는 그 답에서 비는 부분을 메우는 확장이다.

1. **동결 후 reduce-only 청산.** [구현 기준 2026-09-23] 3.4의 6번으로 구현했다. 아래는 계획 당시 문안이다. 동결 시점에 포지션을 닫지 않으면 실제 venue에서는 증거금이 venue에 남고, 동결된 에이전트는 줄일 수도 없다. 확장: 누구나 호출할 수 있는 바운티 있는 `unwind()`가 동결된 포지션을 블록당 일정 비율씩(Hyperliquid는 인출 증거금 부족 시 20%씩 닫는다) 슬리피지 상한 안에서 줄인다. 다 줄이면 `Frozen -> Closed`로 전이하고 allocator는 현금으로 인출한다. `IVenueAdapter`에 reduce-only 진입점이 필요하다. 조건 문구는 "X%에서 에이전트가 멈추고 청산이 시작된다. 확정 손실은 슬리피지와 갭만큼 X%보다 클 수 있다"로 쓴다. 인출 시 비례 청산은 두 번째 경로다.
2. **조건 고정.** [구현 기준 2026-09-23] 3.4의 7번으로 구현했다(`lockTerms`, 잠금 전 예치 거부, `termsHash`). Registry 앵커는 3.7과 함께, timelock은 두지 않았다. 아래는 계획 당시 문안이다. mandate 조건 해시를 3.7 Registry release에 앵커하고, 변경은 timelock 뒤에 두거나 새 mandate로만 허용한다.
3. **체결 전 변동성 검사.** [구현 기준 2026-09-23] 3.4의 8번으로 구현했다(`RiskLimits`에 `volWindowSeconds`·`stressHorizonSeconds`·`stressSigmasX10` 추가, mark로 쌓는 EWMA 분산, 노출을 늘리는 주문의 k-sigma 스트레스 거절 `StressBreach`, 누구나 부르는 `observe()`, view `stressQuote()`). 아래 후보 중 변동성 연동 레버리지 상한은 만들지 않았고(8절), breaker는 이 거절이 그것이다. 권장 범위는 README "What each term bounds"에 있다. 아래는 계획 당시 문안이다. 체결 후 변동성 대응은 1번이 맡고, 여기서는 체결 전만 다룬다. 후보: `Marked`마다 갱신하는 온체인 실현 변동성 추정치(mark 수익률의 EWMA), `preview` 단계 스트레스 테스트(체결 후 포지션에 k-sigma 변동을 가정했을 때 `maxDrawdownBps`를 넘으면 거절), 변동성에 반비례하는 레버리지 상한(`min(maxLeverage, targetVol / sigma)`), 변동성 급등 시 위험을 늘리는 주문만 거절하는 breaker(동결이 아니라 거절). 3.5의 가격 원천에 그대로 의존하므로 mock venue에서는 서버가 밀어 넣는 가격 경로로 시연한다.
4. **조건 범위 확장.** adapter별 instrument·방향·집중도 whitelist, `FeeTerms` 구현, venue mark와 참조 가격의 편차 상한.
5. **다음 발표 전 검증 과제.** 원래 8개 조건 각각의 권장 범위와 근거(변동성 조항 3개의 범위는 README에 적었다). 확인할 자료: 거래소의 변동성 연동 증거금 구간, DeFi 위험 매개변수 설정 관행, vol-targeting 문헌, 온체인 변동성 원천. 아직 확인하지 않은 항목은 발표에서 "확인 중"으로 표시한다.


# Mandate 기술명세서

버전 0.2 · Monad Metropolis Track 1 · v1 구현 기준

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
- 배분 원본 intent와 watchlist는 공개 체인에 올리지 않고 Reporter 입력으로만 사용한다.
- `BatchAllocator`는 공개된 개별 전송을 완전히 익명화하지 않는다. 동일 에폭의 요청을 합쳐 에이전트별 순액을 정산해 직접적인 `allocator → agent vault` 연결을 줄이는 역할이다.
- 체인 분석으로 드러나는 입출금 정보를 DP가 숨긴다고 주장하지 않는다.
- Reporter 침해는 표시 통계와 비공개 intent 정보에 영향을 주지만 Vault 자금 이동 권한을 주지 않는다.

## 3. 온체인 컴포넌트

### 3.1 공통 타입

```solidity
enum AgentState { Active, Frozen, Closed }

struct RiskLimits {
    uint16 maxLeverageX100;
    uint16 maxRealizedDrawdownBps;
    uint16 maxSlippageBps;
    uint32 minBlocksBetweenTrades;
    uint8 maxConsecutiveRejects;
    uint256 maxOrderNotional;
    uint256 maxPositionNotional;
    uint256 maxTotalNotional;
    uint256 maxBlockNotional;
}

struct FeeTerms {
    uint16 perfFeeBps;
    uint16 protocolFeeBps;
}
```

### 3.2 MandateVault

에이전트별 비수탁 볼트다. Allocator 또는 승인된 `BatchAllocator`가 USDC를 예치하고 지분을 받는다. 에이전트는 등록된 `VenueAdapter`를 통한 거래만 요청할 수 있고 자금 인출·임의 전송은 할 수 없다.

```solidity
interface IMandateVault {
    event Allocated(address indexed receiver, uint256 assets, uint256 shares);
    event Withdrawn(address indexed owner, uint256 assets, uint256 shares);
    event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl);
    event PerfFeeAccrued(uint256 amount, uint256 highWater);

    function allocate(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 shares, address receiver) external returns (uint256 assets);
    function execute(address adapter, bytes calldata order) external;
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
  → RiskGuard.checkBefore(vault, adapter, preview)
      ├─ violation: revert (외부 거래 없음)
      └─ pass: adapter.execute(...)
                   → validate amountOut/slippage/resulting state
                       ├─ mismatch: whole transaction reverts atomically
                       └─ valid: accounting update and event
```

`revert`된 트랜잭션 안에서 `Frozen` 상태를 영구 기록할 수 없으므로 두 경로를 분리한다.

1. 단일 정상 한도 위반: 거래만 revert한다.
2. 반복 위반: Relay/keeper가 실패 영수증 또는 서명된 주문 증거를 제출하는 별도 트랜잭션 `recordRejectedOrder`로 카운트한다.
3. `maxConsecutiveRejects` 도달: 별도 트랜잭션에서 Agent를 `Frozen`으로 전환한다.
4. 즉시 동결이 필요한 관리·침해 상황: guardian의 `freezeAgent`를 사용하고 사유를 이벤트로 남긴다.
5. Frozen 상태: 신규 execute/allocate는 차단하고 allocator withdrawal은 유지한다.

거부 카운트 증거가 복잡해지는 것을 막기 위해 v1 데모에서는 신뢰된 `ExecutionRelay`가 EIP-712 주문과 트랜잭션 영수증을 제출한다. 이 경로는 자금 안전 불변식이 아니라 운영상 자동 동결을 위한 보조 통제다.

### 3.5 가격 및 Drawdown 정의

v1 MockVenue는 결정론적 온체인 가격을 제공한다. 데모의 레버리지와 mark-to-market 위험 지표는 이 가격에만 의존한다.

```solidity
interface IPriceSource {
    function priceE18(address asset) external view returns (uint256);
    function updatedAt(address asset) external view returns (uint256);
}
```

- v1: `DeterministicMockPriceSource`; 시나리오별 가격 변화가 온체인 트랜잭션으로 기록된다.
- production 확장: TWAP 또는 검증된 oracle, staleness/deviation guard 추가.
- 가격피드 없이 강제할 수 있는 값은 `realizedDrawdown`으로만 부르며 mark-to-market DD와 혼용하지 않는다.

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
    function claimShares(uint256 epoch, bytes32[] calldata proof) external;
}
```

에폭 흐름:

1. 사용자가 USDC를 escrow에 예치한다.
2. UI에서 EIP-712 `AllocationIntent`에 서명한다. 원본 intent는 API에 저장되고 즉시 온체인 게시하지 않는다.
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

## 5. FlyGraph 데모 에이전트

초파리 커넥톰은 Mandate의 보안 근거가 아니라 범용적인 실행 제한을 보여주는 선택적 실험 에이전트다.

정확한 설명:

> FlyGraph is a connectome-topology-inspired graph policy agent. It uses a fixed fly-derived graph as an inductive bias; it is not a biological brain simulation and is not assumed to be inherently risk-averse.

### 입력 및 출력

| 시장/볼트 입력 | 그래프 입력 채널 | 정규화 |
|---|---|---|
| 단기 수익률 | direction | `clip(return / sigma, -1, 1)` |
| 거래량 변화 | stimulus intensity | rolling z-score |
| bid-ask spread | market friction | `[0,1]` |
| 실현 변동성 | threat intensity | rolling volatility |
| vault drawdown | internal stress | `drawdown / limit` |
| RiskGuard utilization | inhibitory control | limit utilization |
| signed exposure | body state | `[-1,1]` |

출력은 `LONG / FLAT / SHORT`와 `0% / 10% / 25%` 크기로 양자화한다. Relay는 NaN, 무한대, 범위 밖 값, checkpoint 불일치 및 cooldown 위반을 거부한다.

### 등록 및 검증

- 고정 graph topology hash
- feature schema hash
- trained checkpoint hash
- build/version hash
- MLP 및 degree-preserving random graph baseline과 out-of-sample 비교
- 지표: net return, max drawdown, turnover, RiskGuard rejection count, seed variance

모델은 주문을 제안할 뿐이며 안전을 결정하지 않는다. 모든 주문은 동일한 Adapter/RiskGuard 경로를 통과한다.

## 6. 핵심 불변식

1. Agent는 allocator 또는 Vault 자금을 직접 인출·전송·승인할 수 없다.
2. 승인되지 않은 Adapter를 통한 외부 호출은 불가능하다.
3. 외부 거래 전에 주문·블록·포지션·총노셔널 한도를 검증한다.
4. Adapter 결과 불일치 시 전체 트랜잭션이 원자적으로 revert된다.
5. Frozen 이후 execute와 신규 allocate는 차단되며 withdraw는 유지된다.
6. 총 발행 shares는 사용자·BatchAllocator claim entitlement와 일치한다.
7. escrow 자산은 정산 또는 deadline 이후 환불만 가능하다.
8. cumulative ε는 단조 증가하고 상한 초과 릴리즈는 거부된다.
9. 동일 epoch/pinnedBlock/statsVersion의 digest는 변경할 수 없다.
10. malicious token/venue callback이 Vault 회계에 reentrancy를 일으킬 수 없다.

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

1. Agent/FlyGraph 등록
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

## 9. 이후 확장

- TWAP/다중 oracle 및 circuit breaker
- permissionless Adapter audit/registration process
- threshold reporter와 검증 가능한 randomness
- shielded batch funding 또는 privacy pool
- delayed RFQ execution
- RDP accountant와 multi-epoch scheduler


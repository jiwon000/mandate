# Mandate

**수탁 권한 없이 자율 트레이딩 에이전트를 지원합니다. 실행 권한은 온체인에서 제한하고, 시장 신호는 범위를 명시한 차등 프라이버시로 공개합니다.**

Mandate는 Monad에서 자율 트레이딩 에이전트에 자본을 배분하는 온체인 시장입니다. 배분자는 출금 권한을 유지하고, 에이전트는 거래 실행 권한만 받습니다. 모든 주문은 거래 venue에 도달하기 전에 전용 Adapter와 온체인 `RiskGuard` 검사를 통과해야 합니다.

Monad Metropolis Track 1인 Onchain Finance & Trading을 대상으로 제작되었습니다.

## 구현 현황

현재 저장소에는 Vault·Adapter·RiskGuard 핵심 기능과 BatchAllocator가 구현되어 있습니다. 여기에는 marked equity 기반 손실 한도, EIP-712 배분 intent, escrow, 에폭별 순배분, Merkle 지분 claim, intent 취소와 미사용 escrow 환불이 포함됩니다. 2026-09-23 진행 발표 피드백으로 동결 후 reduce-only `unwind()`, 일방향 조건 잠금 `lockTerms()`, 변동성 조항(`StressBreach`)이 추가되었습니다. 2026-10-04에 `MandateRegistry`가 추가되어 에이전트 카탈로그와 DP 릴리즈 앵커를 제공합니다.

현재 프라이버시 경계는 명확합니다. 정산에 포함된 allocation intent와 서명은 정산 calldata에서 공개됩니다. 배치 순정산은 직접 연결을 줄이지만 완전한 익명성을 제공하지 않습니다. 원본 intent가 체인에 전혀 올라가지 않는다는 더 강한 v0.2 문구는 아직 구현되지 않았고, 비공개 Intent API도 예정 사항입니다. `reporter/` 모듈이 2026-10-04에 추가됐지만 범위는 **공개 데이터에 한정**됩니다: 이미 공개된 정산 금액과 거래 수익률만 DP로 집계하고, 스펙이 말하는 "개별 watchlist"와 "정산 전 intent"의 private demand DP는 해당 기능 자체가 데모에 없어서 v1 범위 밖으로 명시적으로 뺐습니다.

`web/` 데모는 서버 시작 시 in-process chain을 배포하고 네 개의 테스트 Vault를 실행합니다. `--live`로 시작하면 같은 네 개 Vault를 Monad 테스트넷에 배포한 것에 연결되고, 서버가 데모 키로 대신 서명하므로 방문자는 지갑 없이 실제 트랜잭션을 보냅니다(아래 "데모 실행"). MockVenue는 온체인 가격으로 현금과 미실현 손익을 반영한 equity를 계산하고 그 가격으로 지분을 발행·상환합니다. 청산이나 funding 비용은 구현하지 않았으므로 실제 파생상품 회계의 증거로 사용할 수 없습니다.

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
- 동결 후 누구나 `unwind()`로 포지션을 5회에 걸쳐 20%씩 reduce-only 청산 (venue mark 대비 슬리피지 1% 이내, 호출자 bounty 0.01%), 마지막 단계에서 `Frozen -> Closed`
- 일방향 조건 잠금 `lockTerms()`: 잠근 뒤에는 한도와 Adapter 허용 목록을 바꿀 수 없고, 잠그기 전에는 예치가 거절되며, `termsHash`가 배분자가 인용하는 조건 값
- 변동성 조항: guard가 본 mark(거래·`poke()`·부작용 없는 `observe()`)로 실현 변동성을 추정하고, 조건의 horizon 동안 k-sigma 이동이 `maxDrawdownBps`를 넘기면 노출을 늘리는 주문을 `StressBreach`로 거절. 노출을 줄이는 주문은 검사하지 않음
- 첫 예치 share inflation을 막는 `MIN_SHARES` 잠금
- `MandateRegistry`: `registerAgent()`는 `guard`를 파라미터로 받지 않고 `vault.riskGuard()`에서 직접 읽어 — 호출자가 제시한 `limits`가 그 guard의 실제 locked `termsHash`와 일치하고 `adapter`가 allowlist에 있을 때만 카탈로그에 기록됨. 호출자는 guard의 owner로 제한(`OnlyGuardOwner`) — `fees`/`modelHash`는 온체인에 대조할 근거가 없는 선언적 값이라 아무나 등록하게 두면 안 됐음(2026-10-04 보안 리뷰에서 가짜 guard로 vault를 선점하는 취약점 발견 후 수정, `docs/security-review-2026-10-04.md`). `postLeaderboard()`는 단일 설정된 reporter 키의 EIP-712 서명만 받고, epoch·pinnedBlock 단조 증가와 누적 ε 장부(`cumulativeEpsilonE6 == 이전값 + epsilonPerfE6 + epsilonIntentE6`, 설정된 상한 초과 거부)를 온체인에서 강제
- EIP-712 intent 기반 에폭 배치 예치, Merkle claim, 취소와 환불 — `web/`의 Batch 화면에서 서명·제출·정산·클레임까지 end-to-end로 연결됨
- `reporter/`: 공개 정산 금액과 거래 수익률(`[-c,c]` clip)의 mean/Sharpe/max drawdown을 순수 ε-DP(Laplace 메커니즘, scale = `2·clipBound/(N·ε)`)로 집계. 노이즈는 `HMAC_SHA256(reporterSecret, domainSeparator||epochId||pinnedBlock||statsVersion)` 시드로 결정론적으로 생성되고, `EpsilonLedger`가 `MandateRegistry`와 동일한 누적 ε 산식·상한을 먼저 체크해서 온체인에서 거부될 release는 애초에 서명하지 않음. Privacy Simulator(`reporter/simulator.mjs`)는 같은 scale 공식을 쓰되 ledger·secret에 전혀 접근하지 않는 별도 모듈 — 슬라이더가 실제 ε 예산을 쓸 수 없는 구조

로컬 테스트는 in-memory EVM에 전체 경로를 배포합니다. 현재 컴파일과 계약 테스트 61개(Hardhat/node:test, MandateRegistry 12개·DP Reporter 14개 포함)와 데모 서버 테스트 43개(`npm run test:web`, 서명 allowlist·gas 한도·batcher/reporter 포함)가 통과합니다. 여기에 Foundry 기반 stateful invariant 테스트(Vault/RiskGuard 핵심 불변식 9개 + Registry의 ε 장부 불변식 4개, 각 128 runs × depth 32)와 malicious-token reentrancy 테스트 3개가 추가되어 `npm run test:contracts`가 다루지 않는 임의 호출 순서·악의적 asset 시나리오를 검증합니다 (`npm run test:invariant`).

## 동작 흐름

1. 운영자가 하나의 `VenueAdapter`에 연결된 Vault를 배포하고 `MandateRiskGuard`에 한도를 설정한 뒤 `lockTerms()`로 잠급니다. 잠그기 전에는 예치가 거절됩니다.
2. 배분자가 USDC를 escrow에 예치하고 EIP-712 allocation intent에 서명합니다.
3. `BatchAllocator`가 에폭 종료 후 Vault별 순액을 한 번 예치하고 사용자가 Merkle proof로 지분을 claim합니다.
4. 에이전트가 Adapter를 통해 주문을 제출하면 Adapter가 노셔널과 예상 포지션을 계산합니다.
5. RiskGuard가 외부 호출 전에 한도를 확인합니다. 노출을 늘리는 주문은 변동성 조항의 스트레스 검사도 통과해야 합니다. 위반 주문은 venue 상태를 바꾸지 않고 revert됩니다.
6. 체결 후 가격 mark와 drawdown을 다시 검사합니다. 한도 초과 Vault는 동결되지만 배분자의 출금과 지분 이전은 유지됩니다.
7. 누구나 `poke()`를 호출해 최신 mark 기준 drawdown을 확인할 수 있습니다.
8. 동결된 Vault는 누구나 `unwind()`를 5회 호출해 청산할 수 있고, 마지막 단계에서 `Closed`가 되어 출금에 새 mark가 필요 없어집니다.

## 보안 및 프라이버시 한계

Mandate는 임의의 `(venue, selector)` 호출을 허용하지 않습니다. 지원 venue마다 주문 해석, 사전 상태 계산, 원자적 외부 호출을 보장하는 Adapter가 필요합니다. 시장가치 위험 한도는 설정된 가격 소스에 의존하며, 데모는 결정론적 MockVenue를 사용합니다. 실서비스에서는 TWAP 또는 검증된 oracle과 stale/deviation guard가 필요합니다.

DP는 공개 블록체인 거래를 숨기지 않습니다. 거래·Vault 상태·escrow·정산 금액은 공개되며, `reporter/`는 바로 그 공개 데이터(정산 금액, 거래 수익률)를 DP 집계해 Privacy 화면에 게시합니다. 스펙이 말하는 비공개 watchlist·정산 전 demand DP는 해당 기능 자체가 데모에 없어서 v1 범위 밖입니다. 현재 웹 데모의 수치는 서버가 시작할 때 배포한 로컬 체인의 contract read와 transaction을 사용합니다.

## 데모 실행

```bash
npm ci
npm run compile
npm run test:contracts
npm run web
```

[Foundry](https://getfoundry.sh)가 설치되어 있으면 invariant/fuzz 테스트도 돌릴 수 있습니다.

```bash
forge install
npm run test:invariant
```

브라우저에서 `http://localhost:3000`을 엽니다. 포트가 사용 중이면 `PORT=3001 npm run web`처럼 다른 포트를 지정할 수 있습니다.

데모 화면은 Market, Agent, Allocate, Batch, Privacy, Live Risk로 구성됩니다. Allocate에서 테스트 USDC를 즉시 예치하고, Live Risk에서 정상 주문·한도 초과 주문·가격 충격·`poke()` 동결·변동성 조항의 `StressBreach` 거절과 reduce-only 주문 통과·`unwind()` 청산·동결 후 출금 흐름을 확인할 수 있습니다. Privacy 화면에서는 `postLeaderboard()`로 DP release를 직접 게시하고, 페이지가 서버 응답을 그냥 믿지 않고 `MandateRegistry.releaseOf()`를 다시 읽어 digest가 일치하는지 "VERIFIED ONCHAIN"으로 보여줍니다. 옆의 Privacy Simulator 슬라이더는 체인을 전혀 호출하지 않는 순수 클라이언트 계산입니다.

배치 intent 정산 [구현 기준 2026-10-04]: Batch 화면에서 escrow 예치, EIP-712 `AllocationIntent` 서명(off-chain, 무료), 서명된 intent를 모아 epoch 종료 후 `settleEpoch()`로 정산, Merkle proof로 `claimShares()`까지 전부 웹에서 연결됩니다. 데모 서버가 `deploy.mjs`와 동일하게 배포자 키를 batcher로 사용해 정산을 대신 실행하고, 데모용 epoch은 20초로 짧게 잡았습니다(운영 배포 기본값은 1시간). 서명된 intent는 settlement calldata에 공개되므로 이 batcher는 익명성 집합이 아닙니다.

### 라이브 테스트넷 데모

같은 화면을 Monad 테스트넷 위에서 띄울 수 있습니다. 서버가 네 개 Vault를 한 번 배포한 뒤, 방문자의 클릭을 서버가 보관한 테스트넷 전용 데모 키로 서명하고 가스를 대신 냅니다. 방문자는 지갑 확장도 faucet도 필요 없고, 피드의 각 항목은 monadscan 트랜잭션으로 연결됩니다.

공개 인스턴스: <https://mandate-e4kb.onrender.com> (Monad 테스트넷, chainId 10143)

```bash
cp .env.example .env        # MONAD_RPC_URL, DEMO_MNEMONIC(테스트넷 전용), DEMO_ADMIN_TOKEN
npm run compile
npm run deploy:demo         # 한 번: 배포·시드 후 web/deployments/10143.json 기록, 주소 표 출력
npm run web:live            # 페이지 서빙 + 오라클 + 대리 서명
```

니모닉의 0번 계정이 배포·지불합니다(테스트넷 가스 가격 약 100 gwei에서 배포와 시드에 실측 약 1.25 MON, 데모 계정 6개에 각 0.4 MON 송금. 스크립트는 시작 전에 4 MON을 요구합니다). 데모 계정 잔액이 0.2 MON 아래로 내려가면 0번 계정이 시간당 6 MON 한도 안에서 다시 채웁니다. 1~5번과 9번이 배분자·에이전트 4·keeper이고 서버는 이 6개로만 서명합니다. 공개 URL에서의 안전장치는 역할별 함수 allowlist(배분자는 `execute` 불가, 에이전트는 `withdraw` 불가, value 전송 불가), 트랜잭션당 가스 상한, 분당 서명·충격 횟수 제한, 운영자 토큰(`?admin=<토큰>`)이 있어야 보이는 Reset 버튼입니다. 오라클은 누가 보고 있으면 5초, 아니면 5분 간격으로 마크를 갱신하므로 Tight Mandate의 mark age 조건은 로컬 4초 대신 10초입니다. 공개 테스트넷 RPC는 IP당 `eth_call`을 초당 15건만 받는데(2026-10-04 실측) 페이지 새로고침 한 번이 32~34건이라, 서버가 한 묶음의 읽기를 Multicall3 `aggregate3` 호출 하나로 합치고 제한에 걸린 호출은 잠깐 뒤 다시 보냅니다. 방문자가 떠난 뒤 Vault 2개 이상이 동결돼 있으면 서버가 스스로 재배포합니다. Batch와 Privacy 화면도 라이브에서 동작합니다(배치 정산 컨트랙트와 레지스트리가 포함된 배포 기록일 때). 서버가 배처와 리포터 역할을 맡아 배분자의 `AllocationIntent`만 EIP-712로 서명하고, epoch이 끝나면 `settleEpoch()`를, 표본이 모이면 `postLeaderboard()`를 배포 계정 비용으로 보냅니다. 두 트랜잭션은 시간당 가스 한도와 횟수 제한 안에서만 나갑니다. Linux 호스트용 systemd 유닛은 `deploy/systemd/mandate-web.service`에 있고, 전체 절차와 환경 변수는 영문 [Live testnet demo](#live-testnet-demo) 절에 있습니다. 실제 네트워크에 올리기 전에 `npx hardhat node`를 띄우고 `MONAD_RPC_URL=http://127.0.0.1:8545`로 같은 절차를 리허설할 수 있습니다.

2026-10-04에 Monad 테스트넷(chain 10143)에 배포했습니다. 컨트랙트 주소 8개와, 예치·주문·가격 충격·`poke()` 동결·동결 후 주문 거절·`unwind()`까지 한 바퀴를 돈 트랜잭션 해시는 영문 [Recorded run on Monad testnet](#recorded-run-on-monad-testnet) 절에 있습니다. AI 코딩 도구 사용 고지와 서드파티 코드 출처는 [AI tool disclosure](#ai-tool-disclosure), [Third-party code](#third-party-code) 절에 있습니다.

## 저장소 구조

```text
contracts/src/          Vault, RiskGuard, Adapter, BatchAllocator, interface, mock
contracts/test-js/      in-process Hardhat EVM 계약 테스트
contracts/test/         Foundry invariant/fuzz 테스트와 reentrancy 테스트
contracts/script/       deploy-demo.mjs(네 개 Vault), deploy.mjs(단일 Vault), keeper.mjs, artifacts.mjs
contracts/tools/        로컬 solc 컴파일러와 EIP-712/Merkle helper
reporter/               DP release 계산: clipping, Laplace noise, epsilon ledger, EIP-712 서명, Privacy Simulator
web/                    Market, Agent, Allocate, Batch, Privacy, Live Risk 화면, 데모 서버, in-process chain(chain.mjs)과 라이브 RPC 프록시(live.mjs)
web/deployments/        deploy-demo.mjs가 쓰는 <chainId>.json. 라이브 서버가 여기서 시작
deploy/systemd/         Linux 호스트용 라이브 데모 유닛 파일
docs/                   마일스톤 설계 문서
mandate-v0.3-frontend/  이전 프론트엔드 설계 스냅샷
```

## 다음 작업

외부 감사(제3자 진행 중)가 남아 있습니다. 라이브 데모는 공개 호스팅했습니다([라이브 테스트넷 데모](#라이브-테스트넷-데모)). baseline 에이전트 구현은 2026-10-04부로 범위에서 제외했습니다 — 프로토콜의 보안 근거는 RiskGuard/Vault에 있지 에이전트 구현에 있지 않으므로, 지금은 우선순위가 아닙니다. Monad 테스트넷에는 2026-10-04에 배포했고 주소와 실행 트랜잭션을 게시했습니다([Recorded run on Monad testnet](#recorded-run-on-monad-testnet)).

Invariant·fuzz 테스트 [구현 기준 2026-10-04]: `contracts/test/`에 Foundry 기반 stateful invariant 테스트를 추가했습니다. Vault·RiskGuard·MockVenueAdapter를 대상으로 allocate/withdraw/transferShares/execute/poke/unwind/가격 충격/시간 경과를 임의 순서로 섞어 핵심 불변식 9개(custody, 상태 전이, share 회계, lockTerms, 변동성 조항)를 검증하고, 악의적 ERC20 asset으로 reentrancy 3개를 별도 검증합니다. 각 invariant는 가드를 일부러 제거해 실패하는 것을 확인한 뒤 복원하는 방식으로 교차검증했습니다.

배치 흐름의 웹 연결 [구현 기준 2026-10-04]: `web/`이 더는 BatchAllocator를 우회하지 않습니다. `chain.mjs`가 배포 시 BatchAllocator를 배포·allowlist하고, 서버가 서명된 intent를 모아 epoch 종료 후 batcher로서 `settleEpoch()`를 호출하며, Merkle proof를 재구성해 클레임을 돌려줍니다. 단일 intent와 2-vault/2-allocator 다중 intent 정산을 직접 스크립트로 재현해 검증했습니다. batcher는 여전히 중앙화돼 있고(배포자 키), 정산 calldata에 포함된 intent는 공개됩니다 — `docs/batch-allocator-milestone2.md`의 프라이버시 경계는 그대로입니다.

MandateRegistry [구현 기준 2026-10-04]: §3.7 인터페이스를 구현했습니다. `registerAgent()`는 `keccak256(abi.encode(limits))`가 해당 vault의 실제 `termsHash`와 일치하고 adapter가 guard allowlist에 있어야만 통과해서, 등록된 카탈로그가 실제 온체인 조건과 어긋날 수 없습니다. `fees`(`FeeTerms`)는 Vault에 수수료 엔진 자체가 없어서 강제되지 않는 선언적 메타데이터입니다. `postLeaderboard()`는 단일 설정된 reporter의 EIP-712 서명만 받고, epoch/pinnedBlock 단조 증가와 `cumulativeEpsilonE6 == 이전값 + epsilonPerfE6 + epsilonIntentE6` 정확한 합, 설정된 상한 초과 거부를 체크합니다(핵심 불변식 #8, #9). Foundry invariant(128 runs × depth 32)로 ε 장부가 역행하거나 상한을 넘거나 실제 승인된 릴리즈 합과 어긋나지 않는지 추가 검증했고, 상한 체크를 일부러 제거해 invariant가 잡아내는 것도 확인했습니다.

보안 리뷰 [구현 기준 2026-10-04]: Slither 정적 분석(45개 findings, 전부 트리아지 — 2개는 실제 수정, 나머지는 이 코드베이스 패턴에서 false positive임을 근거와 함께 문서화)과 `security-review` 스킬을 통한 2차 검토를 진행했습니다. 2차 검토에서 **진짜 취약점**을 찾았습니다: `registerAgent()`가 원래 `guard` 주소를 파라미터로 받아서 내부 일관성만 체크했는데, 공격자가 모든 체크에 "통과"로 답하는 가짜 guard 컨트랙트를 배포하면 실제 vault의 1회용 등록 슬롯을 조작된 정보로 영구 점유할 수 있었습니다 — "호출자가 거짓말할 방법이 없다"는 원래 주장이 거짓이었던 셈입니다. `guard`를 파라미터에서 빼고 `vault.riskGuard()`에서 직접 읽도록 고쳤고, `fees`/`modelHash`는 온체인 근거가 없는 선언적 값이라 호출자를 guard의 owner로 제한했습니다. 이 수정 자체를 다시 적대적으로 검토하는 2차 라운드도 돌렸습니다 — 수정은 견고하다고 확인됐고(실제 vault 하이재킹은 완전히 막힘, 사소한 문서 정확도 지적 하나만 반영), 같은 위험군(실제 자금 + EIP-712 서명)인 `BatchAllocator`도 같은 기준으로 다시 봤는데 새로운 문제는 없었습니다. 자세한 내용은 [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md) 참고. 이건 내부 리뷰이지 외부 감사를 대체하지 않습니다.

DP Reporter [구현 기준 2026-10-04]: `reporter/` 모듈이 실제 통계를 계산·노이즈 처리해 서명합니다. 범위는 의도적으로 좁습니다 — 이미 공개된 정산 금액·거래 수익률만 Laplace 메커니즘(`scale = 2·clipBound/(N·ε)`)으로 DP 집계하고, 스펙의 "private watchlist"·"정산 전 intent" DP는 해당 기능 자체가 데모에 없어서 v1 범위 밖입니다. `EpsilonLedger`가 `MandateRegistry`와 완전히 동일한 장부 검증을 먼저 통과시키므로 빌드된 release는 온체인에서 거부될 수 없고, 통합 테스트로 실제 `postLeaderboard()`가 받아들이는 것까지 확인했습니다.

Privacy 화면 연결 [구현 기준 2026-10-04]: `chain.mjs`가 배포 시 4개 vault를 모두 `MandateRegistry`에 등록하고, 매 가격 tick마다 vault별 NAV 수익률을 모읍니다. 웹의 Privacy 화면에서 `postLeaderboard()`를 클릭하면 서버가 release를 만들어 서명·게시하고, 페이지는 서버 응답을 그대로 믿지 않고 `registry.releaseOf()`를 직접 읽어 digest가 일치하는지 대조해서 "VERIFIED ONCHAIN"을 표시합니다. Privacy Simulator 슬라이더는 같은 scale 공식을 쓰되 체인 호출이나 ledger 접근이 전혀 없는 순수 클라이언트 계산입니다.

자세한 인터페이스와 상태 전이는 [`mandate-technical-spec-v0.2.md`](mandate-technical-spec-v0.2.md)와 [BatchAllocator 마일스톤 문서](docs/batch-allocator-milestone2.md)를 참고하세요.

---

# Mandate (English)

**Back autonomous trading agents without custody — execution constrained on-chain, market signals published with scoped differential privacy.**

Mandate is a live capital-allocation market for autonomous trading agents on Monad. Allocators hold withdrawal rights no agent or operator can revoke, agents receive execution-only permissions, and every order must pass an adapter-specific on-chain `RiskGuard` before it reaches a venue.

Built for Monad Metropolis, Track 1: Onchain Finance & Trading.

## Implementation status

The sections below describe the target v1 product. The current repository implements the Vault/Adapter/RiskGuard core with mark-to-market drawdown enforcement, the milestone-2 `BatchAllocator` (escrow, EIP-712 authorization, per-vault epoch deposits, Merkle claims, cancellation and refunds of unspent escrow), `MandateRegistry` (self-verifying agent catalog and DP release anchor), and a `reporter/` module that computes and signs real DP releases over public data. See [the milestone-2 design and ABI](docs/batch-allocator-milestone2.md).

**Current privacy boundary:** included allocation intents and signatures become public in settlement calldata. Net deposits do not hide those allocator-to-vault links. The stronger v0.2 statement that raw intents never go on-chain is not implemented. There is no private Intent API, and `reporter/` is scoped to public data only (2026-10-04): it DP-releases settlement amounts and trade returns, which are already on-chain, rather than the private watchlist/pre-settlement-intent signals the v0.2 spec sketches — those have no corresponding feature in this demo, so there is nothing yet to protect.

Fee accounting is pending (`FeeTerms` exists only as declared metadata on `MandateRegistry`, with no deduction mechanism behind it). The demo book is deployed on Monad testnet; addresses and a recorded run are under [Recorded run on Monad testnet](#recorded-run-on-monad-testnet). The six-screen frontend in `web/` runs against an in-process chain that the server deploys on boot, or, started with `--live`, against the same four-mandate book deployed to Monad testnet through a server-signed proxy (see [Live testnet demo](#live-testnet-demo)). The mock venue marks each vault's equity (cash plus unrealised PnL) to its on-chain price and shares are minted and redeemed at that mark; it does not liquidate positions or charge funding, so a passing open-position withdrawal test is not evidence of production derivatives accounting. Foundry invariant/fuzz testing and an internal security review are implemented (`contracts/test/`, [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md)); an external audit is in progress with a third party.

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
- reduce-only unwind of a frozen position: anyone can call `unwind()` five times, each closes a fifth of the size at freeze inside a 1% slippage bound and pays 0.01% of cash; the last step moves the vault `Frozen -> Closed`
- one-way terms lock: `lockTerms()` makes the limits and the adapter allowlist final, a vault refuses deposits until its terms are locked, and `termsHash` is the value an allocator can quote
- volatility clause: the guard keeps a realised-volatility estimate built from the marks it sees (every trade, `poke()` and the side-effect-free `observe()` feed it), and an order that adds exposure is refused with `StressBreach` when a k-sigma move over the mandate's horizon would leave the vault past `maxDrawdownBps`; orders that reduce exposure are never stress-tested
- first-deposit share lock (Uniswap-V2-style `MIN_SHARES`) against share-price inflation
- epoch batch allocation: escrow, EIP-712 intents, netting, Merkle claims, cancellation and refunds — connected end to end in `web/`'s Batch screen (sign, queue, settle, claim), not only in the contract tests
- `MandateRegistry`: self-verifying `registerAgent()` reads `guard` from `vault.riskGuard()` itself rather than taking it as a parameter (claimed `RiskLimits` must hash to that guard's own locked `termsHash`; the adapter must be on its allowlist), and is restricted to the guard's owner since `fees`/`modelHash` have no on-chain ground truth to check (see "Security review" below — an earlier version trusted a caller-supplied `guard` address and was exploitable); `postLeaderboard()` gated by a single reporter's EIP-712 signature, enforcing strictly increasing epoch/pinnedBlock and an exact additive epsilon ledger against a configurable cap
- `reporter/`: clips trade returns to `[-c, c]` and DP-releases mean return, Sharpe and marked max drawdown via the Laplace mechanism, with deterministic HMAC-seeded noise and an epsilon ledger that mirrors `MandateRegistry`'s own accounting so a built release is never one the contract would refuse

The local test suite (`npm run test:contracts`) deploys the full contract path to an in-memory EVM and verifies all of the above (61 cases). `npm run test:web` covers the demo server (43 cases): the signing allowlist, the gas bounds, and the live batcher and reporter. `npm run test:invariant` runs a separate Foundry suite — stateful invariant fuzzing of the Vault/RiskGuard/Adapter path (9 properties) and of `MandateRegistry`'s epsilon ledger (4 properties), plus malicious-ERC20 reentrancy tests — covering arbitrary call sequences the hand-written Hardhat tests don't attempt.

## Why Mandate

Autonomous agents can generate trades, but an allocator still needs answers to three questions:

1. Can the agent take the money?
2. Can the agent exceed the agreed risk mandate?
3. Can market demand and performance be compared without publishing every private expression of interest?

Mandate separates those concerns. Vault custody and execution constraints are enforced on-chain. Public chain activity (settlement amounts, trade returns) is DP-released as a performance leaderboard, never presented as hidden. The spec also calls for private watchlists and pre-settlement allocation intents to be released only as DP aggregates; this demo has no watchlist feature and nothing private to aggregate there yet, so that half is explicitly out of v1 scope rather than implemented against invented data.

## How it works

1. An operator deploys a vault bound to one `VenueAdapter`, configures its risk limits in `MandateRiskGuard` and locks them. The vault takes no deposit before the lock, and after it neither the limits nor the adapter allowlist can change. `registerAgent()` then catalogs it on `MandateRegistry`, checking the claimed limits against the vault's own `termsHash` rather than trusting the caller. Fee terms are declared metadata only; the vault has no fee-deduction mechanism yet.
2. Allocators escrow USDC and sign EIP-712 allocation intents. A `BatchAllocator` settles each epoch as net allocations to agent vaults.
3. The agent submits an order through its dedicated Adapter. The Adapter previews the resulting exposure and `RiskGuard` checks it before any external call.
4. Valid orders execute atomically. Limit violations revert before trading. Unexpected results revert the entire transaction. After the trade the guard re-marks the vault and checks drawdown.
5. Anyone can call `poke()` between trades. If the marked drawdown exceeds the mandate, the vault freezes and the caller is paid a small bounty out of the vault.
6. Allocators claim shares and can withdraw at the marked price, position included. Agents never receive withdrawal authority.
7. A DP Reporter (`reporter/`) publishes performance confidence intervals over public settlement data with a signed digest and cumulative ε anchored on `MandateRegistry`. Private demand aggregates are not implemented — see Privacy model.

## Architecture

```text
Allocator → signed intent → Intent API (planned) → BatchAllocator → net allocation → MandateVault
                              │                                            │
                              └─ DP private-demand aggregates (planned)    └─ shares / withdrawal

Agent → MandateVault → MockVenueAdapter → MandateRiskGuard pre-check → DeterministicMockVenue
                                          └─ post-trade mark / poke() → freeze + bounty

reporter/ (DPReporter) → signed stats digest + published ε → MandateRegistry.postLeaderboard()
```

### Core contracts

- `MandateVault` — USDC custody, share accounting at marked NAV, execution-only agent role, freeze that keeps withdrawals open.
- `MockVenueAdapter` (`IVenueAdapter`) — order decoding, exposure preview, atomic execution and `markEquity()` for the guard.
- `MandateRiskGuard` — order, position, total, leverage, per-block and cooldown limits before a trade; mark age and mark-to-market drawdown after it and on `poke()`.
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

As of 2026-10-04, `reporter/` computes and signs DP releases for the two rows above that are already public data — mean return, Sharpe and marked max drawdown, clipped to `[-c, c]` and noised with the Laplace mechanism (`scale = 2c / (N·ε)`, the standard report-noisy-mean sensitivity). The two private-signal rows have no implementation: inventing a watchlist feature just to have something to anonymize would be privacy theater, so v1 only protects data that is genuinely sensitive and genuinely collected.

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

A freeze stops the agent but does not close the position, so the loss can keep growing while the vault waits. Anyone can call `MandateVault.unwind()` on a frozen vault. Each call asks the adapter to close a fifth of the size the position had at the freeze (Hyperliquid uses the same 20% step when a withdrawal needs margin), reduce-only and inside `MAX_UNWIND_SLIPPAGE_BPS` (1%) of the venue mark, and pays the caller `UNWIND_BOUNTY_BPS` (0.01%) of cash. One step per block. When nothing is left on the book the vault moves `Frozen -> Closed`: no trades, no deposits, no more unwinding, and `withdraw()` no longer needs a fresh mark because there is no position left to misprice. The term therefore reads "the agent stops at X% and liquidation starts; the realised loss can exceed X% by slippage and gaps".

The terms an allocator reads are the terms they get. `MandateRiskGuard.lockTerms(vault)` is one-way: after it `configure()` and `setAdapter()` revert with `LimitsLocked`, and until it has happened `MandateVault.allocate()` reverts with `TermsNotLocked`. Money only ever enters behind terms the owner can no longer rewrite, which is what turns "read the terms" into a claim the contract enforces. `termsHash(vault)` is the keccak256 of the eleven limits in `RiskLimits` order; the UI shows it and a registry release would anchor it. There is no timelock or amendment path: a different mandate is a new vault.

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
| `maxMarkAgeSeconds` | age of the venue price the guard is allowed to trust (0 disables) | trade, allocation, withdrawal and `poke()` revert until the price is refreshed |
| `maxDrawdownBps` | NAV per share below its high-water mark, mark-to-market | vault freezes: no more trades or deposits, withdrawals stay open; anyone can then `unwind()` the position in five steps and the vault ends `Closed` |
| `volWindowSeconds` | memory of the realised-volatility estimate: how many seconds of marks one squared return is averaged over (0 disables the clause) | no violation of its own; sets how fast the estimate reacts and decays |
| `stressHorizonSeconds` | the horizon the estimate is scaled to before the stress move is taken | no violation of its own |
| `stressSigmasX10` | the move, in tenths of a standard deviation over the horizon, an exposure-adding order must survive without breaching `maxDrawdownBps` (30 = 3 sigma) | order reverts with `StressBreach`; reducing orders are exempt; nothing freezes |

Ten of the eleven terms reject one order and stop (the three volatility fields are one check); only the drawdown term changes the vault's state, and only through a mark. The guard's inputs are the adapter's order preview, the venue mark (price and its timestamp), the vault's share supply and cash, and the variance the guard itself has accumulated from those marks. No external volatility oracle is involved.

Suggested ranges for the volatility clause, with the reasoning. `volWindowSeconds`: at least a few dozen marks long, so one print does not dominate, and no longer than the regime you want to react to; Chainlink's realised-volatility feeds publish 24-hour, 7-day and 30-day windows sampled every 10 minutes, and the demo uses 60 to 300 seconds only because its marks arrive every second. `stressHorizonSeconds`: the time it takes to get out, which for a frozen vault is five `unwind()` blocks plus however long nobody calls them; 60 seconds to a day. `stressSigmasX10`: 20 to 40, two to four standard deviations, with 30 as the default; exchange portfolio-margin systems also stress against fixed scenario moves, but the exact ranges they use have not been verified here and are not quoted. Volatility-targeted position sizing is known to cut the left tail of returns (Man Group, "The Impact of Volatility Targeting"), which is the effect the clause borrows.

## Demo flow

The demo in `web/` has six screens: Market, Agent, Allocate, Batch, Privacy and Live Risk.

1. Compare the four mandates on Market: drawdown, leverage and mark age are each shown against the limit the allocator accepted.
2. Open one on Agent: NAV per share against its high-water mark, and every limit as a bar against what is used.
3. Approve and allocate test USDC on Allocate; shares are minted at the marked NAV.
4. Send an order inside the mandate on Live Risk and watch it pass the guard.
5. Send an over-limit order and see the guard's own custom error decoded from the revert data, before any venue state changes.
6. Push a price shock, then call `poke()` from an account that is neither allocator nor agent: the vault past its drawdown limit freezes and the caller is paid the bounty.
7. Select Range Carry after the same 2% shock. Its drawdown is about 3% against a 12% mandate, so nothing freezes, but the stressed-drawdown tile jumps: realised volatility is now roughly 200 bps over 120 seconds, three of those is a 6% move, and the vault would sit about 15% under water if the agent added exposure at 2.1x. The same "inside mandate" order that passed in step 4 now reverts with `StressBreach(196, 588, 1480)` before any venue state changes; the reduce-only order still passes. Leave the tape alone for about 70 seconds and the estimate decays under the limit, and the order passes again.
8. Switch the node to 12-second blocks: the mandate that asks for a 4-second mark can no longer be enforced and starts reverting with `MarkTooOld`.
9. Withdraw from the frozen vault at marked NAV while its position is still open.

10. On Batch, deposit to escrow, sign an `AllocationIntent` for the current epoch (off-chain, free), and once the epoch ends, settle it (the demo server plays the batcher role `deploy.mjs` gives the deployer key on Monad) and claim the resulting shares with the reconstructed Merkle proof.
11. On Privacy, click `postLeaderboard()` once a few price ticks have landed: the server pools public per-vault NAV returns, clips and Laplace-noises the mean/Sharpe/max-drawdown, signs a release and anchors it on `MandateRegistry`. The page re-reads `releaseOf()` straight from the contract and shows `VERIFIED ONCHAIN` once the digest it computed matches what it just read back — not just what the server's JSON claimed. The Privacy Simulator slider next to it never calls the chain: moving ε only recomputes a confidence interval over a synthetic example, using the real reporter's own `scale = 2·clipBound/(N·ε)` formula.

## Honest limitations

- DP does not hide public blockchain transactions.
- Batch netting reduces direct linkage but does not provide full allocator anonymity.
- The v1 Reporter and batcher are centralized, although neither can withdraw vault funds; escrow has an on-chain timeout refund.
- `reporter/`'s DP releases cover only data that was already public (settlement amounts, trade returns). The spec's "private watchlist" and "pre-settlement intent" DP aggregates are not implemented, because the demo has no watchlist feature and no private-intent signal to aggregate in the first place — building one just to anonymize it would not protect anything real.
- The deterministic MockVenue proves contract behavior, not production price safety or liquidity. It also does not settle: closing a position through `unwind()` books the realised PnL into the venue's cost basis instead of moving tokens, so a `Closed` vault's equity is its cash plus that realised PnL while its token balance is unchanged. A real venue would settle the loss out of margin.
- RiskGuard limits behavior; it does not guarantee strategy quality or prevent losses inside the mandate.
- A withdrawal needs a mark inside the vault's `maxMarkAgeSeconds`. Redeeming against a price nobody can vouch for would hand the difference to whoever stays, so the vault refuses rather than guesses. No agent, operator or freeze can hold a withdrawal - only a stale mark can, and only until it refreshes.
- A vault is permanently bound to the adapter it was constructed with. There is no venue migration path.
- One vault with a stale mark or in `Frozen` state reverts the whole epoch in `BatchAllocator.settleEpoch()`, since settlement allocates to every vault in a single transaction. The batcher has to leave such vaults out of the batch.
- The first deposit into a vault permanently locks `MIN_SHARES` (1e3 share units) to a dead address so a first depositor cannot inflate the share price against later allocators. The first depositor pays that dust.
- `poke()` pays its bounty out of the vault, so a breach costs allocators 0.05% on top of the drawdown, and each of the five `unwind()` steps costs another 0.01%. That is the price of not needing a trusted keeper.
- `unwind()` closes at whatever the venue fills inside a 1% bound of its own mark. In a gap or a thin book the realised loss lands past `maxDrawdownBps`; the term bounds when liquidation starts, not where it ends. If the venue cannot fill inside the bound the step reverts and the position stays open until it can.
- Locked terms cannot be amended, not even to tighten them; different terms mean a new vault. The lock covers the limits and the adapter allowlist, not the venue's price source. An owner who never calls `lockTerms()` has a vault nobody can deposit into.
- On a testnet deployment the venue price comes from the deployer's keeper script, so the mark is only as honest as that keeper. A production venue would supply its own price.
- The live demo signs for its visitors. Nobody installs a wallet: the server holds six testnet-only keys derived from one mnemonic (an allocator, four agents, a keeper) and signs the browser's `eth_sendTransaction` on their behalf, so anyone with the URL is spending the operator's testnet gas. The proxy limits the damage - each key may only call the functions its role is allowed on the contracts it was deployed with, no value transfers, a gas cap per transaction, a global rate limit, and a reset that only the operator's token can trigger - but it is a demo convenience, not a custody model. The contracts never see the proxy; the same book works with a real wallet against the same addresses.
- The live oracle is a transaction per mark. While a browser is open it re-marks the venue every 5 seconds (plus `observe()` every 60 seconds), and backs off to one mark every 5 minutes when nobody is watching. Tight Mandate's mark-age term is therefore 10 seconds on a live chain instead of the local 4 seconds, and a page opened after an idle stretch can show `MarkTooOld` for one beat until the oracle notices it. The execution feed only scans the last 90 blocks on load, so a fresh page starts almost empty on a chain that has been running for a while.
- The volatility estimate starts at zero. A freshly deployed vault, or one whose window has fully decayed, is not stress-tested until the tape moves; the clause protects against a spike that has already begun, not the first print of it.
- The estimate is only as good as its sampling. It only sees the marks that reach the guard, so a mark series nobody observes for an hour is one squared return spread over that hour, and a jump that reverts between two samples is invisible. The demo keeper feeds every mark through `observe()`; a live deployment needs someone to do the same, and Chainlink's realised-volatility feeds solve the same problem with a fixed 10-minute sampling grid.
- "k sigma" assumes returns that are roughly normal at the horizon. Crypto returns are fat-tailed, so a 3-sigma clause is a calibrated cushion, not a probability. The stressed drawdown also treats the move as a straight loss at the order's leverage, ignoring funding, fees and any hedge.
- The clause is a per-order refusal, not a volatility-scaled leverage cap. The agent can keep the exposure it already has, whatever the tape does; only the drawdown term can take it away.
- A withdrawal is capped by the cash the vault holds. Shares are priced at the marked value of the open position, but the vault can only pay out what is not tied up in it; the unpaid part of a claim stays as shares until the agent frees up cash or, after a freeze, until `unwind()` has closed the position.

## Repository layout

```text
contracts/src/          MandateVault, MandateRiskGuard, MockVenueAdapter, BatchAllocator, MandateRegistry, interfaces, mocks
contracts/test-js/      node:test suites against an in-process Hardhat 3 (EDR) chain
contracts/test/         Foundry invariant/fuzz and reentrancy tests
contracts/script/       deploy-demo.mjs (the four-mandate book), deploy.mjs (one vault), keeper.mjs, artifacts.mjs
contracts/tools/        solc compile runner and the EIP-712 / Merkle helper (batch.mjs)
reporter/               DP release computation: clipping, Laplace noise, epsilon ledger, EIP-712 signing, Privacy Simulator
web/                    Market, Agent, Allocate, Batch, Privacy and Live Risk screens, demo server, in-process chain (chain.mjs) and live-RPC proxy (live.mjs)
web/deployments/        <chainId>.json written by deploy-demo.mjs; the live server boots from it
deploy/systemd/         unit file for running the live demo on a Linux host
docs/                   Milestone design notes
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
11. Security review (2026-10-04): Slither static analysis across all of `contracts/src` (45 findings, triaged — 2 fixed, the rest documented as false positives inherent to this codebase's patterns), plus an independent LLM-driven review of the full PR diff. That second pass found a real vulnerability: `MandateRegistry.registerAgent()` took `guard` as a caller-supplied parameter and only checked it for internal self-consistency, so a fake guard contract that answered every check "yes" could permanently squat a real vault's one-time registry slot with fabricated terms. Fixed by reading `guard` from `vault.riskGuard()` directly (no longer a parameter at all) and restricting the call to that guard's owner, since the remaining `fees`/`modelHash` fields have no on-chain ground truth to check. Full writeup: [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md). This is an internal review, not a substitute for an external audit.

Next:

12. An external, independent security audit (in progress with a third party). The live demo is publicly hosted (see [Live testnet demo](#live-testnet-demo)) and the testnet deployment is published under "Recorded run on Monad testnet". A baseline agent is explicitly out of scope (2026-10-04 decision): the protocol's security claims rest on RiskGuard/Vault, not on any particular agent implementation.

From the 2026-09-23 progress review (the reviewers asked what the terms and their ranges are, what happens after a freeze, and how volatility enters). Item 4 above answers "what happens after a freeze", item 5 "can the terms I read change" and item 6 "where does volatility enter"; the rest:

13. Term coverage. Per-adapter instrument, direction and concentration whitelist; a bound on how far the venue mark may deviate from a reference price. `FeeTerms` exists as of 2026-10-04 but only as declared metadata on `MandateRegistry` — `MandateVault` has no fee-deduction mechanism to enforce it against. Recommended ranges for the eight original terms, with the sources they come from, are due before the next review; the volatility clause's ranges are under "What each term bounds".

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

Use Node 22.14 or newer. After `npm ci`, the local `solc` 0.8.37 runner and the in-process Hardhat tests work without network access. `foundry.toml` configures `contracts/test/`'s stateful invariant suites and reentrancy tests, run with `forge test` (`npm run test:invariant`); the production path is still compiled separately by `contracts/tools/compile.mjs` for Hardhat and the web demo, so Foundry's `via_ir` build flag (needed by one test handler) never affects what ships. CI (`.github/workflows/ci.yml`) runs both suites on every push and pull request.

## Live testnet demo

The same screens can run against Monad testnet, with no wallet extension and no faucet trip for the visitor. The server deploys the book once, then signs every click with demo keys it holds and pays the gas. Every number is still a contract read against the live chain, every button still a transaction with an explorer link in the feed.

A public instance runs at <https://mandate-e4kb.onrender.com> (Monad testnet, chain 10143).

```bash
cp .env.example .env        # MONAD_RPC_URL, DEMO_MNEMONIC (testnet-only), DEMO_ADMIN_TOKEN
npm run compile
npm run deploy:demo         # once: deploys and seeds, writes web/deployments/10143.json, prints the address table
npm run web:live            # serves the page, runs the oracle, signs on visitors' behalf
```

Both scripts read `.env` through `node --env-file-if-exists`, so nothing has to be exported by hand. Account 0 of the mnemonic deploys and pays (a measured 1.25 MON or so for the deploy and seeding at the testnet's gas price of about 100 gwei, plus 0.4 MON sent to each of the six demo accounts); `deploy:demo` refuses to start with less than 4 MON. Accounts 1 to 5 and 9 are the allocator, the four agents and the keeper; the server signs with those six and never with account 0. The deployment file is meant to be committed for a real network (`web/deployments/31337.json`, a local rehearsal, is ignored).

What the visitor gets:

- The header names the network, and every feed entry links to the transaction on monadscan.
- Allocate, order, poke and unwind buttons work as on the local chain; the server signs `approve`/`allocate`/`withdraw` as the allocator, `execute` as the selected vault's agent, and `poke`/`unwind` as whichever account the page has adopted (the allocator once "Connect allocator" is pressed, the keeper before that).
- The block-cadence toggle is gone (the chain's cadence is its own) and `Reset demo` only appears when the page is opened with `?admin=<DEMO_ADMIN_TOKEN>`.
- The note under the control room reports the oracle's current cadence, how many marks it has pushed and the gas spent so far.
- Batch and Privacy run on a book deployed with the batch allocator and the registry, which every `deploy:demo` since 2026-10-04 produces; on an older record the two tabs are hidden. The server is the batcher and the reporter: it signs the allocator's `AllocationIntent` when the page asks for an EIP-712 signature, queues it, nets the epoch into one `settleEpoch()`, and posts a DP release with `postLeaderboard()`.

How the server keeps itself safe on a public URL:

- Allowlist per role. A request to sign is refused unless the `from` account is one of the six demo keys, the target is a contract from the deployment, the selector is in that role's list (the allocator may not `execute`, an agent may not `withdraw`), and no value is attached. Refusals come back as JSON-RPC errors the page prints.
- Gas cap (`MAX_GAS_PER_TX`, 1.5M) after a server-side estimate, so a reverting call costs nothing and a runaway one is not signed. The signed limit is the estimate plus `GAS_HEADROOM_PERCENT` (50): an oracle mark that lands between the estimate and inclusion makes `poke()` and `execute()` write more than was estimated, and Monad bills the limit whether or not it is used, so a transaction signed at the bare estimate can run out of gas and still be paid for in full. Reverts surface with their custom-error data, so the page decodes `LeverageExceeded`, `StressBreach` and friends exactly as it does locally.
- Rate limits: `SEND_TX_PER_MINUTE` (40) signed transactions and `CONTROL_PER_MINUTE` (12) shocks per minute across all visitors. Read methods are forwarded to the upstream RPC from a short allowlist; anything else (`evm_mine`, `eth_sign`, ...) is `-32601`. Every visitor's reads share the server's upstream quota, and that quota is small: the public testnet RPC answers 15 `eth_call` a second per IP (measured 2026-10-04) while one page refresh is 32 to 34 reads, and inside a batch it refuses the surplus entry by entry under HTTP 200, where a client's ordinary 429 retry never sees it. So the proxy folds a batch's plain reads into one Multicall3 `aggregate3` call (`PACK_READS`, used when the chain has Multicall3 at its canonical address), resends whatever was refused for rate after a short pause, and answers identical reads from a `READ_CACHE_MS` (2000) cache that the server clears whenever it signs, marks or sees a receipt go by. None of the contracts' views depend on `msg.sender`, so a bundled read returns what a direct one would.
- Typed data. `eth_signTypedData_v4` is answered for one request only: an `AllocationIntent` from the allocator, in the EIP-712 domain of this deployment's batch allocator, for a vault of this book. Any other signer, domain, primary type or field list is refused, so the proxy cannot be made to sign a permit or an order for another contract.
- Batcher and reporter (`web/live-desks.mjs`). `settleEpoch()` reverts as a whole when one intent is stale and the deployer pays for what reaches the chain, so an intent is checked when it arrives (signature, epoch still settleable, nonce neither used nor queued, vault `Active`, escrow covering everything queued) and again right before settlement. A batch that would still revert is taken apart with one `eth_call` per intent and settled without the intents that sink it. Nothing is sent that did not pass a gas estimate. One settlement is capped at `SETTLE_MAX_GAS` (2M), an epoch takes `BATCH_MAX_PER_EPOCH` (8) intents and the queue `BATCH_MAX_PENDING` (32), settlements are limited to `SETTLE_PER_MINUTE` (3) and releases to one every `REPORT_MIN_SECONDS` (120), and the two together draw on `DESK_GAS_PER_HOUR` (10M) of signed gas, about 1 MON at 100 gwei. A release's noise is seeded from `DEMO_REPORTER_SECRET`, or from a random value drawn at boot; it is never derived from a signing key. The queue, the claim proofs and the reporter's samples live in memory and are dropped by a restart or a reset.
- Presence-aware oracle. A visitor makes the server mark every `ORACLE_ACTIVE_SECONDS` (5) and `observe()` every `ORACLE_OBSERVE_SECONDS` (60); `PRESENCE_SECONDS` (60) after the last request it drops to `ORACLE_IDLE_SECONDS` (300). A shock lands on the next beat, so the price moves within seconds either way.
- Gas for the demo accounts. Each of the six starts with `DEMO_GAS_PER_ACCOUNT_MON` (0.4). When one drops under `DEMO_GAS_FLOOR_MON` (0.2) the deployer fills it back up, within `DEMO_TOPUP_PER_HOUR_MON` (6) an hour so a visitor hammering the buttons cannot drain it, and never below its own `OWNER_RESERVE_MON` (1) so the oracle keeps marking. `/api/control` reports what has been refilled and says so when an account is low and cannot be.
- Reset policy. `Reset demo` needs the admin token and respects `RESET_COOLDOWN_SECONDS` (600). With `AUTO_RESET` on (default), the server also redeploys by itself when a visitor leaves and at least `AUTO_RESET_MIN_FROZEN` (2) vaults are no longer `Active`, provided the deployer still holds `RESET_MIN_BALANCE_MON` (3). Each redeploy is a fresh book at new addresses; the page follows automatically.

`deploy/systemd/mandate-web.service` runs it on a Linux host (`/opt/mandate`, a dedicated user, `.env` at mode 600); put a TLS reverse proxy in front of port 3000. The budget for ten days of judging traffic is on the order of 20-30 testnet MON. Rehearse the whole thing offline first with `npx hardhat node` and `MONAD_RPC_URL=http://127.0.0.1:8545`; the proxy, the oracle and the reset path behave the same, only the explorer links are missing.

### Recorded run on Monad testnet

The book below was deployed to Monad testnet (chain 10143) on 2026-10-04 by `0xFCb12322Cd13e5aC40155a46CA6D353625B97684`. The table is a copy of `web/deployments/10143.json`, the file the server boots from, as it stood after that deployment. A hosted demo redeploys itself after visitors leave vaults frozen, so a live page may be on a newer book than this one. These addresses and transactions stay on chain either way.

| Contract | Address |
| --- | --- |
| MockUSDC | [`0x276A14be2b5D62580A58c74A29D348CF509AA4f6`](https://testnet.monadscan.com/address/0x276A14be2b5D62580A58c74A29D348CF509AA4f6) |
| MandateRiskGuard | [`0xF340f0ae74585ecCF806e94Cbc507c18BC91d5f5`](https://testnet.monadscan.com/address/0xF340f0ae74585ecCF806e94Cbc507c18BC91d5f5) |
| DeterministicMockVenue | [`0xC23e3fE7F931207233a804765c024DEf9C1F7BA4`](https://testnet.monadscan.com/address/0xC23e3fE7F931207233a804765c024DEf9C1F7BA4) |
| MockVenueAdapter | [`0x97AD5BA742297f4c3CEA5841f1c825B581Bc3354`](https://testnet.monadscan.com/address/0x97AD5BA742297f4c3CEA5841f1c825B581Bc3354) |
| MandateVault · Steady Basis | [`0x0309A8c6C9D416251D2786042857DAba9AE64388`](https://testnet.monadscan.com/address/0x0309A8c6C9D416251D2786042857DAba9AE64388) |
| MandateVault · Range Carry | [`0xEAF037275B74f0536c38387130Fe4b758e395341`](https://testnet.monadscan.com/address/0xEAF037275B74f0536c38387130Fe4b758e395341) |
| MandateVault · Momentum Vector | [`0xd1092e7637DADBa48873B8ed2B35CfEcc0eF6318`](https://testnet.monadscan.com/address/0xd1092e7637DADBa48873B8ed2B35CfEcc0eF6318) |
| MandateVault · Tight Mandate | [`0x3de51B731E5F145B44a0d5D5F684459ff120505c`](https://testnet.monadscan.com/address/0x3de51B731E5F145B44a0d5D5F684459ff120505c) |

One pass through the demo against that book, every step sent through the page's `/rpc` proxy and signed by the server's demo keys:

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

Each transaction was confirmed 1.1 to 1.6 seconds after the request reached the server. In the same session eight consecutive `poke()` calls on Tight Mandate, 4.5 seconds apart on a quiet market, all passed its 10-second mark-age term; not one reverted with `MarkTooOld`.

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

AI coding tools were used to build this repository, and the rules of Monad Metropolis ask for that to be stated. Commits that carry a `Co-Authored-By: Claude …` trailer were written with Claude Code (Anthropic's CLI, models Claude Fable 5.1 and Claude Opus 5) under the committer's direction. They touch the contracts, the tests, the deploy scripts, the demo server and page, and this README; `git log` shows which commits those are. The team set the design and the requirements and decided what was merged.

## Third-party code

- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) 5.4.0 (MIT): `ERC20`, `IERC20`, `SafeERC20`, `ReentrancyGuard`, `Ownable`, `EIP712`, `ECDSA`, `MerkleProof`, `Math`, imported unmodified from the npm package.
- [Hardhat](https://github.com/NomicFoundation/hardhat) 3 (MIT), [ethers](https://github.com/ethers-io/ethers.js) 6 (MIT) and [solc-js](https://github.com/ethereum/solc-js) 0.8.37 (MIT) as development dependencies.
- [Multicall3](https://github.com/mds1/multicall3) (MIT) is not vendored; the live server calls the canonical deployment at `0xcA11bde05977b3631167028862bE2a173976CA11` to bundle reads.
- The page loads the Manrope and DM Mono typefaces from Google Fonts (SIL Open Font License).

## License

MIT. See [LICENSE](LICENSE).

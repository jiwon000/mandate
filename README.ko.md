# Mandate

[English](README.md) | 한국어

공개 데모: <https://mandate-e4kb.onrender.com> (Monad 테스트넷, chainId 10143. 지갑 없이 사용 가능. 무료 서버라 첫 접속은 깨어나는 데 1~2분 걸립니다)

**수탁 권한 없이 자율 트레이딩 에이전트를 지원합니다: 실행 권한은 온체인에서 제한되고, 공개된 성과 통계는 차등 프라이버시 노이즈를 거쳐 서명과 함께 게시되고, ε 소비는 온체인 장부가 상한을 지킵니다.**

Mandate는 Monad에서 자율 트레이딩 에이전트에 자본을 배분하는 온체인 시장입니다. 배분자의 돈은 Vault 컨트랙트에 남고, 에이전트는 주문 실행 권한 하나만 받습니다. 모든 주문은 거래소에 닿기 전에 온체인 `RiskGuard`의 조건 검사를 통과해야 합니다. 배분자가 답해야 할 질문이 "이 트레이더를 믿을 수 있나"에서 "이 조건을 받아들일 수 있나"로 바뀝니다.

Monad Metropolis Track 1 (Onchain Finance & Trading) 출품작입니다. 전체 문서는 영문 [README](README.md)이고, 이 문서는 그 요약입니다.

- 제출 현황과 제출 글: [`docs/submission/`](docs/submission/README.md)

## 현재 상태 (2026-10-12)

| 구성 요소 | 상태 |
| --- | --- |
| Vault, RiskGuard, Adapter, 조건 잠금, 동결과 `unwind()` | Monad 테스트넷 배포, 공개 데모에서 동작 |
| `MandateFactory` 무허가 볼트 개설 | 공개 데모 Launch 화면 (브라우저 지갑 필요) |
| 조건 19개: 리스크 한도 11, 거래 조건 6, 수수료 2 (선택 사항인 참조가격 조건 2개를 쓰면 21개, unwind bounty 정액 하한까지 쓰면 22개) | 온체인 강제, 모두 `termsHash` 하나로 잠김 |
| `BatchAllocator`, `MandateRegistry`, DP 리포터 | 공개 데모 Batch·Privacy 화면 |
| `PerplAdapter` (Monad의 perp 거래소 Perpl) | Monad 테스트넷에 배포. Perpl 테스트넷 거래소에서 입금, 거래, 출금 왕복 1회, 이어서 규칙 기반 에이전트 스크립트로 5회 실행해 주문 20건 체결, 한도 초과 주문 9건 온체인 거부 |
| 거래소와 USDC | mock. 테스트넷 가격은 팀의 키퍼가 넣음 |
| 보안 검토 | 내부 리뷰 4라운드. 외부 감사 없음 |
| 테스트 | 계약 144개, 서버 76개, Foundry 27개(invariant 21개, reentrancy 3개, unwind bounty 하한 3개). CI에서 실행 |

## 조건

조건은 첫 예치 전에 `lockTerms()`로 잠기고, 그 뒤로는 누구도 바꿀 수 없습니다. 잠기기 전의 Vault는 예치를 받지 않습니다. 배분자는 `termsHash` 하나로 자신이 읽은 조건과 체인의 조건이 같은지 확인합니다.

| 묶음 | 조건 | 위반하면 |
| --- | --- | --- |
| 주문 전 검사 | 주문·포지션·총 노셔널, 레버리지, 블록당 노셔널, 거래 간격, 허용 마켓, 방향(롱·숏 전용), 지정가의 mark 대비 괴리, 하루 거래 횟수 | 주문이 revert되고 거래소 상태는 바뀌지 않음. 포지션·총 노셔널, 레버리지, 하루 거래 횟수는 노출을 늘리는 주문(0을 지나 반대 방향으로 가는 주문 포함)에만 적용 |
| 변동성 조항 | 실현 변동성 추정 기간, 스트레스 horizon, k-sigma | 노출을 늘리는 주문을 `StressBreach`로 거절. 줄이는 주문은 통과 |
| 기준가 괴리 (선택, Perpl 전용) | Perpl mark와 Perpl oracle 가격의 괴리, oracle 가격의 나이 | 노출을 늘리는 주문을 거절. 줄이는 주문은 통과 |
| mark 기준 검사 | high-water mark 대비 drawdown, 당일 손실, 최대 보유 시간 | 누구나 `poke()`로 동결하고 bounty(0.05%)를 받음 |
| 가격 신선도 | `maxMarkAgeSeconds` (최대 60초) | 거래·예치 불가. 3배 넘게 갱신이 없으면 누구나 `freezeUnobservable()`로 동결 |
| 수수료 | 운용보수 연 최대 5%, 성과보수 최대 30% (high-water mark 초과분) | 위반 개념 없음. Vault가 신선한 mark에서만 지분으로 징수 |

동결되면 에이전트는 멈추고 배분자의 출금은 열려 있습니다. 누구나 `unwind()`를 호출해 포지션을 reduce-only로 닫을 수 있고(mark 대비 슬리피지 1% 이내, bounty는 현금의 0.01%와 Vault가 잠근 정액 하한 중 큰 쪽이되 현금의 0.2%를 넘지 않음), 포지션이 0이 되면 Vault는 `Closed`가 됩니다. 한 번에 남은 양의 1/5, 1/4, 1/3, 1/2, 전부를 차례로 닫으므로 체결이 다 되면 다섯 번에 동결 시점 크기의 1/5씩 닫히고, 덜 닫힌 양은 이후 호출이 전부 다시 시도합니다. 가격 피드가 멈춘 동결 Vault에서는 `withdrawUnpriced()`로 현금 몫만 먼저 받아 나갈 수 있습니다.

각 조건의 정확한 의미와 권장 범위는 영문 [What each term bounds](README.md#what-each-term-bounds), 동결 규칙의 설계는 [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md)에 있습니다.

## 동작 흐름

공개 데모에서 볼트 하나를 처음부터 끝까지 따라가는 [2분 26초 영상](https://youtu.be/7KrvWPyJ8qg)(영어)이 있습니다.

1. 누구나 `MandateFactory.createMandate()` 한 번으로 Vault를 배포하고 조건을 설정·잠근 뒤 `MandateRegistry`에 등록합니다. 승인하는 사람은 없고, 범위를 벗어난 값은 guard와 팩토리가 거절합니다.
2. 배분자는 Vault에 직접 예치하거나, `BatchAllocator`에 escrow를 넣고 EIP-712 intent에 서명합니다. 배치는 에폭마다 Vault별 순액을 한 번에 예치하고, 배분자는 Merkle proof로 지분을 받습니다.
3. 에이전트가 Adapter로 주문을 보내면 Adapter가 주문 뒤의 노출을 미리 계산하고, RiskGuard가 외부 호출 전에 조건을 검사합니다.
4. 체결 뒤 guard가 Vault를 다시 평가합니다. 거래 사이에는 누구나 `poke()`로 같은 검사를 할 수 있습니다.
5. 조건을 넘은 Vault는 동결되고, 누구나 `unwind()`로 정리합니다. 배분자는 언제든 marked NAV로 출금합니다.
6. 리포터는 공개된 Vault 수익률에 Laplace 노이즈를 더한 통계를 서명해 `MandateRegistry.postLeaderboard()`에 게시하고, 레지스트리는 쓴 ε을 누적해 상한을 넘는 release를 거절합니다.

## Monad를 쓰는 이유

가격 신선도 조건에는 바닥이 있고, 그 바닥은 블록 간격입니다. mark는 트랜잭션으로 갱신되므로 다음 블록의 트랜잭션이 읽을 때 이미 한 블록 간격만큼 오래돼 있습니다. "4초보다 오래된 가격은 믿지 않는다"는 조건은 블록이 4초 안에 오는 체인에서만 지킬 수 있습니다. 12초 블록에서는 다음 블록이 생기기 전에 mark가 만료되어, 오라클 갱신과 같은 블록 뒤쪽에 들어간 거래만 통과하고 나머지는 `MarkTooOld`로 revert됩니다.

로컬 빌드는 오라클을 12초에 한 번으로 묶는 스위치로 이 상황을 재현합니다. 공개 데모의 오라클은 5초마다 갱신하는 유료 트랜잭션이라 가장 엄격한 Vault가 10초 조건을 쓰고, 연속 `poke()` 8회가 모두 1~5초 된 mark로 통과한 기록이 영문 [Recorded run on Monad testnet](README.md#recorded-run-on-monad-testnet)에 있습니다.

## 참여자별로 얻는 것

| 참여자 | 얻는 것 | 내는 것 |
| --- | --- | --- |
| 배분자 | 돈을 Vault에 둔 채 에이전트에 맡기고, 잠긴 조건을 `termsHash`로 확인하며, 언제든 marked NAV로 출금 | 운용보수와 성과보수, 동결 시 bounty |
| 에이전트 운영자 | 수탁 없이 남의 자본으로 거래할 권한, 조건 안에서의 운용보수 연 최대 5%와 성과보수 최대 30% | 조건을 바꿀 수 없음, 위반 시 동결 |
| 누구나 | 조건을 넘은 Vault를 `poke()`로 동결하면 0.05%, `unwind()` 한 번에 현금의 0.01% bounty (Vault에 정액 하한이 잠겨 있으면 그 이상, 현금의 0.2%까지) | 가스 |

## 실행

```bash
npm ci
npm run compile
npm test                    # 계약 테스트와 서버 테스트
npm run web                 # http://localhost:3000, 서버가 띄운 in-process 체인
```

Node 22.14 이상이 필요합니다. 포트가 사용 중이면 `PORT=3001 npm run web`처럼 지정합니다. [Foundry](https://getfoundry.sh)가 있으면 `forge install` 뒤 `npm run test:invariant`로 invariant·reentrancy 테스트를, 네트워크가 있으면 `npm run test:perpl`로 Perpl 포크 테스트를 돌릴 수 있습니다.

화면은 Market, Agent, Allocate, Batch, Privacy, Launch, Live Risk입니다. 숫자는 모두 contract read이고 버튼은 모두 트랜잭션입니다. 로컬 빌드에만 있는 것은 Live Risk의 12초 mark 비교 스위치입니다.

Monad 테스트넷 위의 라이브 모드(`npm run deploy:demo`, `npm run web:live`), 서버가 대신 서명할 때의 안전장치, 오라클과 가스 정책은 영문 [Live testnet demo](README.md#live-testnet-demo) 절에 있습니다. `.env`와 니모닉은 커밋하지 않습니다.

## 주장하지 않는 것

- 수익을 약속하지 않습니다. guard는 행동을 제한할 뿐 전략의 질을 보장하지 않습니다.
- 위험이 사라진다고 주장하지 않습니다. 언제 주문이 거절되고 언제 Vault가 동결되는지가 정해질 뿐, 조건 안의 손실과 가격 갭으로 조건을 넘는 손실은 여전히 생깁니다.
- 실제 거래소에서 거래한다고 주장하지 않습니다. 공개 데모의 거래소와 USDC는 mock이고, Perpl은 테스트넷에서 소액 거래만 해봤으며(2026-10-06과 10-10, 스크립트 실행 약 5시간, 체결 20건) Perpl 팀과의 제휴는 없습니다.
- 사용자, 배분자, 예치 규모, 파트너가 있다고 주장하지 않습니다. 데모에 미리 올라간 배분자와 에이전트는 팀 서버의 테스트넷 키입니다.
- 차등 프라이버시가 비공개 데이터를 보호한다고 주장하지 않습니다. 이미 체인에 공개된 수익률에만 적용합니다.
- 감사를 받았다고 주장하지 않습니다. 검토는 모두 내부 리뷰입니다.
- 다른 체인에서는 만들 수 없다고 주장하지 않습니다. 주장은 더 좁습니다. 블록 간격보다 짧은 가격 신선도 조건은 지킬 수 없으므로, 4초 조건에는 4초 안에 블록이 오는 체인이 필요합니다.

## 한계

- 공개 데모의 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣습니다. MockVenue는 청산과 펀딩을 구현하지 않으므로 실제 파생상품 회계의 증거가 아닙니다. `PerplAdapter`는 테스트넷 배포본으로 소액 거래만 해봤습니다(0.001 BTC, 스크립트 실행 약 5시간).
- 차등 프라이버시는 공개 데이터에만 적용됩니다. 리포터는 이미 체인에 있는 수익률을 집계하므로 메커니즘과 온체인 ε 장부를 보여줄 뿐, 비공개 데이터를 보호하지 않습니다. 명시한 ε은 평균에 대해서만 정확하고, 보호 단위는 수익률 한 틱이라 k개 틱을 낸 Vault 전체는 k·ε로 보호됩니다. 체인은 서명과 ε 장부만 확인하고 노이즈 자체는 확인하지 못합니다. 배치 intent와 서명은 정산 calldata에 공개됩니다.
- 데모의 batcher와 리포터는 팀 서버이고, claim proof를 메모리에 둡니다. 서버가 재시작돼도 정산 calldata에서 `npm run claims:recover`로 proof를 다시 만들 수 있습니다.
- 출금은 Vault가 가진 현금까지만 즉시 나갑니다. 포지션에 묶인 몫은 `requestRedeem()`으로 요청하고 1일 공지 기간을 기다려야 하며, 그 뒤에는 누구나 `deleverageForRedemption()`으로 필요한 만큼 포지션을 줄일 수 있습니다.
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
```

## 문서

- [`mandate-technical-spec-v0.2.md`](mandate-technical-spec-v0.2.md): 인터페이스, 상태 전이, 프라이버시 경계. 이후 바뀐 절에는 구현 메모가 있음
- [`docs/mandate-lifecycle-design.md`](docs/mandate-lifecycle-design.md): 동결 조건과 동결 이후 처리
- [`docs/perpl-adapter.md`](docs/perpl-adapter.md): Perpl 어댑터 구조, 포크 테스트, 발견 사항
- [`docs/batch-allocator-milestone2.md`](docs/batch-allocator-milestone2.md): 배치 배분 설계와 ABI
- [`docs/security-review-2026-10-04.md`](docs/security-review-2026-10-04.md): 내부 보안 리뷰 4라운드
- [`docs/threat-model.md`](docs/threat-model.md): 위협별 대응과 남는 위험, 구성 요소별 장애 시 잃는 것과 남는 것
- [AI tool disclosure](README.md#ai-tool-disclosure), [Third-party code](README.md#third-party-code), [License](README.md#license)

# 제출 준비 현황

> Team working notes for the Monad Metropolis submission, in Korean. The English texts entered in the submission form are the three `.txt` files in this folder.

Monad Metropolis 해커톤 Track 1 (Onchain Finance & Trading) 제출까지의 상태판입니다. 제출 폼에 넣은 글의 원본과 영상 대본 초안도 이 폴더에 있습니다. 기능이 어디까지 구현됐는지는 루트 [README](../../README.md)의 "다음 작업"과 Roadmap이 원본이고, 이 문서는 제출에 필요한 일만 다룹니다.

- 마감: 2026-10-13 23:59 ET (한국 시각 2026-10-14 12:59)
- 마지막 갱신: 2026-10-05
- 제출 폼: <https://hackathon.monad.xyz/project?tab=submission> (팀 계정 로그인 필요)
- 담당은 GitHub 계정으로 적습니다 (@jiwon000, @yahamang)

## 요약

- 제출 폼 체크리스트 5개 중 4개가 끝났습니다. 남은 하나는 영상 2개의 링크입니다.
- 공개 데모 <https://mandate-e4kb.onrender.com> 은 2026-10-05 오후 동결 규칙 컨트랙트로 전환했습니다. Render가 PR #10 이후 커밋을 빌드했고, 관리자 `Reset demo`로 새 컨트랙트 장부를 배포했습니다(2026-10-05 08:08 UTC, 가드에 `MAX_MARK_AGE_CAP` 존재를 체인에서 확인). README "Recorded run on Monad testnet"의 주소 표와 `web/deployments/10143.json`을 이 장부로 갱신했습니다.
- 영상 2개는 아직 녹화하지 않았습니다. 대본 초안이 이 폴더에 있습니다.
- 제출 폼 Description 문구를 저장소 `description.txt`와 다시 맞추는 일(남은 일 3-1)은 아직 남아 있습니다.
- 10-05 오후 동결 규칙을 확정하고 컨트랙트에 구현했습니다(`ea596a0`, 설계 [`docs/mandate-lifecycle-design.md`](../mandate-lifecycle-design.md)). main 대상 새 PR로 올렸고, 공개 데모는 재배포 전까지 기존 컨트랙트로 돕니다(정해야 할 것 11).

## 이 폴더의 파일

| 파일 | 내용 |
| --- | --- |
| [`description.txt`](description.txt) | 폼 "Description"에 저장한 영문 본문. 7,921자 (한도 8,000자) |
| [`go-to-market.txt`](go-to-market.txt) | 폼 "Go-to-market and user acquisition strategy"에 저장한 영문 본문. 5,079자 (한도 8,000자) |
| [`judge-access.txt`](judge-access.txt) | 폼 "Judge access instructions"에 저장한 영문 본문. 4,427자 (한도 8,000자) |
| [`demo-video-script.md`](demo-video-script.md) | Technical demo video (3분 이하) 대본 초안 |
| [`pitch-video-script.md`](pitch-video-script.md) | Pitch video (2분 이하) 대본 초안. 팀 소개 줄은 비어 있음 |
| [`mandate-logo.png`](mandate-logo.png) | 폼에 올린 로고, 1024×1024 |
| [`mandate-logo.source.html`](mandate-logo.source.html) | 로고 원본 (SVG). 데모 페이지의 브랜드 마크와 같은 그림 |

세 `.txt` 파일은 2026-10-05 00:26 UTC에 폼에 저장한 값과 같습니다. 폼의 글을 바꿀 때는 이 폴더의 파일을 먼저 고치고 그 내용을 폼에 붙여 넣습니다. 그래야 폼과 저장소가 어긋나지 않습니다.

글과 대본은 AI 도구(Claude Code)로 쓴 초안입니다. Go-to-market의 가정과 대본의 문장은 팀이 읽고 확정해야 합니다.

## 제출 요건 (공식 규정)

출처는 해커톤 대시보드의 Rules & Guidelines 4.1절과 9절입니다 (2026-09-03 갱신본, 2026-10-04 확인). 한 팀이 한 트랙에 프로젝트 하나를 냅니다. 심사 항목은 다섯 개이고 각 20%입니다: Product Quality & Completeness, Technical Excellence, Monad Integration, Track Fit & Problem Relevance, Innovation & Impact.

| 요건 | 상태 | 비고 |
| --- | --- | --- |
| 공개 GitHub 저장소: 전체 소스, 설치법 README, 오픈소스 라이선스, 외부 코드 출처, 빌드 기간의 커밋 이력 | 충족 | MIT `LICENSE`, README "Third-party code" |
| README에 AI 코딩 도구 사용 고지 | 충족 | README "AI tool disclosure". 아래 "정해야 할 것" 5번 참고 |
| 데모 영상: 3분 이하, 공개 링크(YouTube, Loom, Vimeo), 실제 동작과 Monad 상호작용 장면 | 미착수 | 슬라이드와 목업은 인정되지 않음 |
| Monad 메인넷 또는 테스트넷 배포, 컨트랙트 주소 또는 트랜잭션 해시 | 충족 | README "Recorded run on Monad testnet"에 주소 8개와 트랜잭션 9개 |
| Monad를 쓰는 이유 설명 | 초안 있음 | `description.txt`. 가격 기준 시각(mark age) 논리 |
| 문서: 프로젝트 설명, 아키텍처, 기술 스택, 설치와 배포 방법 | 충족 | 루트 README |
| 플랫폼 제출 | 폼 4/5 | 아래 표 |

## 제출 폼

폼의 체크리스트는 Primary track, Project details, Project logo, Live product, Demo and pitch videos 다섯 개입니다. 마감 전까지 저장하고 고칠 수 있습니다. "REVIEW ENTRY" 버튼은 아직 누르지 않았습니다. 영상 링크까지 넣은 뒤 팀이 같이 확인하고 누릅니다.

| 항목 | 필수 | 조건 | 상태 |
| --- | --- | --- | --- |
| Primary track | 필수 | 1개 선택 | 완료: Onchain Finance & Trading |
| Project logo | 필수 | PNG, JPG, WEBP. 2 MB 이하, 500 px 이상 | 완료: `mandate-logo.png` |
| Project name | 필수 | 120자 | 완료: `Mandate` |
| One-line description | 필수 | 200자 | 완료: README 영문 첫 줄 문구 (139자). "정해야 할 것" 6번 참고 |
| Description | 필수 | 8,000자 | 완료: `description.txt` |
| Go-to-market and user acquisition strategy | 필수 | 8,000자 | 완료: `go-to-market.txt`. 팀 확인 필요 |
| GitHub repository | 필수 | 공개 저장소 | 완료: `https://github.com/jiwon000/mandate` |
| Live product | 필수 | https 링크. Monad 메인넷 또는 테스트넷에서 동작 | 완료: `https://mandate-e4kb.onrender.com/` |
| Technical demo video | 필수 | 3분 이하. 동작하는 제품. 슬라이드와 코드 설명 불가 | 없음 |
| Pitch video | 필수 | 2분 이하. 팀 소개, 문제, 만드는 이유 | 없음 |
| Judge access instructions | 선택 | 8,000자 | 완료: `judge-access.txt` |
| Sponsor bounties | 선택 | 트랙 선택 뒤 추가 | 추가하지 않음. "정해야 할 것" 8번 참고 |
| Product advertisement, X profile | 선택 | 심사와 무관 | 비어 있음 |

## 남은 일

| 순서 | 일 | 담당 | 상태 |
| --- | --- | --- | --- |
| ~~1~~ | ~~브랜치 `docs/roadmap-feedback-0923`의 main 대상 PR 리뷰와 머지~~ | @jiwon000 | 완료 (PR #9 머지됨) |
| ~~2~~ | ~~Render에 새 커밋 배포~~ | @jiwon000 | 완료 (`949d258` 배포, `ORACLE_IDLE_SECONDS=3600` 설정) |
| ~~3~~ | ~~README 주소 표에 BatchAllocator·MandateRegistry 행 추가, `10143.json` 갱신~~ | @jiwon000 | 완료 (2026-10-05 07:08:55 UTC 장부로 갱신) |
| ~~2-1~~ | ~~브랜치의 10-05 오후 커밋(Perpl 로드맵, 동결 규칙 설계와 구현)을 main에 올리는 새 PR 리뷰와 머지~~ | @yahamang | 완료 (PR #10 머지됨, CI 퍼즈 테스트 통과) |
| ~~2-2~~ | ~~공개 데모를 새 컨트랙트로 전환 (Render 배포 → 관리자 `Reset demo` → 주소 표와 `10143.json` 갱신)~~ | @jiwon000, @yahamang | 완료 (2026-10-05 08:08 UTC 장부) |
| 3-1 | 제출 폼 Description을 `description.txt`와 다시 맞추기. 10-05 오후에 테스트 수(43 → 46)와 Batch·Privacy 문장을 고쳤고, 폼에는 그 전 문안이 저장돼 있음 | 팀 | 대기 |
| 4 | 데모 영상 녹화와 업로드, 폼에 링크 입력 | 팀 | 미착수 |
| 5 | 피치 영상 녹화와 업로드, 폼에 링크 입력. 대본의 팀 소개 줄 채우기 | 팀 | 미착수 |
| 6 | 아래 "정해야 할 것" 정리 | 팀 | 진행 중 |
| 7 | 제출 전 최종 점검: 공개 데모에서 `judge-access.txt`의 1~11단계를 그대로 따라 하기, README의 수치와 주소 대조, 폼 "REVIEW ENTRY" | 팀 | 3-1, 4, 5번 뒤 |

## 공개 데모 운영 메모

설정값과 안전장치의 원본은 루트 README의 "라이브 테스트넷 데모"(영문 "Live testnet demo") 절입니다. 여기에는 지금 호스팅 상태에서 알아 둘 것만 적습니다.

- 호스트는 Render 웹 서비스이고, 브랜치 `docs/roadmap-feedback-0923`에서 빌드해 라이브 모드(chainId 10143)로 돕니다.
- 현재 빌드는 `949d258`입니다 (2026-10-05 배포). `web/live-recover.mjs`가 부팅할 때 체인에서 가장 최근 완성 장부를 찾아 쓰므로, 더 이상 커밋된 `10143.json`이나 재배포 가능성에 의존하지 않습니다.
- 공개 데모에 Batch·Privacy 화면이 보입니다. 지금 장부는 2026-10-05 08:08 UTC에 관리자 `Reset demo`로 배포한 동결 규칙 컨트랙트 장부이고, 그 주소가 README "Recorded run on Monad testnet"과 `web/deployments/10143.json`에 반영돼 있습니다. 그 전 장부(07:08:55 UTC, 옛 컨트랙트)는 체인에 남아 있습니다.
- Render의 파일시스템은 재시작과 재배포 때 초기화되지만, `949d258` 이후 빌드는 그때마다 배포 계정의 트랜잭션을 거꾸로 훑어 가장 최근 완성 장부로 부팅하므로(읽기만 하고 MON은 들지 않음, 테스트넷에서 약 40초) 더 이상 재시작마다 재배포가 일어나지 않습니다.
- 대기 중인 의향, claim 증명, 리포터 표본은 메모리에만 있습니다. 재시작하면 사라집니다.
- 공개 데모의 페이지나 `/api`를 열면 오라클이 60초 동안 5초 간격으로 가격을 갱신하고, 그만큼 배포 계정의 테스트넷 MON을 씁니다. 상태 확인은 필요한 만큼만 합니다.
- `ORACLE_IDLE_SECONDS=3600`을 적용해서, 서버가 깨어 있지만 접속자가 없을 때의 대기 비용이 하루 약 1.6 MON에서 약 0.13 MON으로 줄었습니다.
- Privacy 화면의 ε 누적 한도는 release 100회 분량이고 배포마다 새로 시작합니다. 심사 기간에 한도에 가까워지면 재배포합니다.

### 테스트넷 재배포 절차 (참고용 — 더 이상 정기적으로 필요하지 않음)

`web/live-recover.mjs` 배포 뒤로는 서버가 재시작마다 체인의 최신 장부를 스스로 찾으므로, 아래 절차는 새 기능(예: 다섯 번째 vault 추가)으로 장부 구조 자체를 바꿀 때만 필요합니다.

1. 한 사람만 진행합니다. 같은 배포 계정으로 두 곳에서 동시에 서명하면 nonce가 충돌합니다. 재배포하는 동안 Render 서비스를 잠시 중지해 두는 것이 가장 안전합니다. 중지하지 않는다면 공개 데모에 접속자가 없을 때 합니다.
2. 로컬 `.env`에 `MONAD_RPC_URL`과 `DEMO_MNEMONIC`이 있는 상태에서 실행합니다. 스크립트는 배포 계정에 4.5 MON이 없으면 시작하지 않습니다. 배포와 시드에 드는 비용은 약 1.8 MON으로 추정합니다.

   ```bash
   npm run compile
   npm run deploy:demo
   ```

3. 바뀐 `web/deployments/10143.json`을 커밋하고 push합니다. 이 파일에는 공개 주소만 들어갑니다.
4. README "Recorded run on Monad testnet"의 주소 표를 새 주소로 바꾸고 BatchAllocator와 MandateRegistry 행을 추가합니다. 기존 표의 주소와 트랜잭션은 온체인에 남아 있으므로 이전 배포의 기록으로 남겨도 됩니다.
5. Render에서 새 커밋으로 배포합니다.

`.env`와 니모닉은 커밋하지 않습니다. 호스트에는 환경변수 입력 화면으로만 넣습니다.

## 정해야 할 것

1. ~~테스트넷 재배포를 누가 언제 할지~~ — 해결됨: `web/live-recover.mjs` 배포로 서버가 체인에서 스스로 최신 장부를 찾으므로 더 이상 수동 재배포가 필요 없습니다.
2. ~~Render 재시작마다 재배포 비용이 나가는 문제~~ — 해결됨: `949d258` 배포로 재시작 재배포가 멈췄고, 부팅이 약 40초 늘어나는 것은 확인됐습니다(Render가 그 사이 포트를 기다려 줬습니다 — 배포가 정상 완료됨). `ORACLE_IDLE_SECONDS=3600`도 적용해서 대기 비용을 하루 약 0.13 MON으로 낮췄습니다. 문제가 생기면 `RECOVER_BOOK=0`으로 옛 방식(커밋된 파일 신뢰)으로 되돌릴 수 있습니다.
3. ~~외부 감사 문구~~ — 해결됨: 진행 중인 외부 감사 없음 확인. README 세 군데(한국어 "다음 작업", 영문 구현 현황 문단, 영문 Roadmap 12번)는 "외부 감사는 아직 받지 않았습니다"로 이미 일치합니다. 지금까지의 검토는 `docs/security-review-2026-10-04.md`의 내부 리뷰뿐입니다. 별도로 만든 발표 슬라이드(claude.ai 아티팩트)에 "외부 감사 진행 중"이라고 잘못 적혀 있던 걸 발견해 같은 문구로 고쳤습니다.
4. ~~Batch 화면 제목~~ — 완료 확인: `web/index.html`에 "Anyone can ask for settlement; only the batcher sends it"로 이미 반영돼 있습니다.
5. README "AI tool disclosure"는 `Co-Authored-By` 트레일러가 있는 커밋을 기준으로 적혀 있습니다. 트레일러가 없는 커밋 18개 중 병합 커밋 10개를 뺀 나머지 8개를 찾았습니다 (git log로 확인, 2026-10-05):
   - `fed3608` docs: add Korean MIT license translation
   - `21e2602` docs: add Korean README before English documentation
   - `4bcbc9e` chore: include frontend milestone project snapshot
   - `f43e042` fix: label synthetic privacy preview and update epsilon display
   - `545b850` feat(risk): mark-to-market equity, permissionless poke(), and mark-age limits (@yahamang)
   - `df8100d` feat: add interactive frontend demo
   - `65213b6` fix: remove vulnerable Ganache dependency from contract tests
   - `1d23d34` Initial import: Mandate mock core and batch allocator draft

   커밋 기록만으로는 이 8개에 AI 도구를 썼는지 알 수 없습니다 — 트레일러 관행이 2026-10-04부터 생겼을 뿐, 그 전에 AI를 안 썼다는 뜻은 아닙니다. 각 커밋을 쓴 사람(@jiwon000, @yahamang)이 직접 확인해서, AI를 썼다면 "AI tool disclosure" 절에 한 줄을 추가해야 합니다.
6. ~~한 줄 설명의 "market signals" 문구~~ — 해결됨 (2026-10-05): "시장 신호"가 실제로 게시하는 것(공개된 볼트 성과 통계)보다 넓게 읽혀서, README 한국어·영문 첫 줄을 "published performance stats carry a verifiable, on-chain differential-privacy budget" (공개된 성과 통계는 온체인에서 검증 가능한 차등 프라이버시 예산 안에서 게시됩니다)로 바꿨습니다. 폼의 "One-line description"도 이 문구로 다시 붙여넣어야 합니다 (영문 172자, 한도 200자).
7. ~~DP 리포터의 단일 Laplace 스케일 문제~~ — 결정됨 (2026-10-05): 코드는 그대로 둡니다. Sharpe와 최대 낙폭은 clip된 입력에서의 실제 민감도(sensitivity)가 아직 유도되지 않았는데, 지금 시간 압박 속에서 직접 새 수식을 유도하면 틀릴 위험이 검증 안 된 주장을 하나 더 만드는 것과 같습니다 — "평균에 대해서만 정확하다"고 솔직하게 범위를 좁히는 쪽이 더 안전합니다. 이미 `description.txt`에 정확히 그렇게 적혀 있었고, README "Published ε vs Privacy Simulator" 절과 `reporter/reporter.mjs`의 코드 주석에도 같은 설명을 추가해 세 곳이 일치하도록 맞췄습니다.
8. Sponsor bounty를 추가할지 (웹 검색으로 확인, 2026-10-05). Perpl "Best use of Perpl's API"($5,000)와 "Best Analytics / Risk Tool"($3,000) 이름·금액·마감(10-13)은 맞습니다. 다만 "Best use of Perpl's API"는 지금 코드(mock venue, 실제 Perpl 연동 없음 — "실사용을 위해 남은 것" 3번 항목)로는 요건을 못 채울 가능성이 큽니다. "Best Analytics / Risk Tool"은 RiskGuard·DP Reporter가 원칙적으로 맞을 수 있지만, 세부 요건(Perpl 실데이터 연동이 필수인지 등)은 검색만으로 확실히 확인 못 했으니 대시보드에서 직접 확인 필요. 검색 중 "메인넷 배포 필수"라는 요약도 나왔는데, 이건 제출 요건 표에 이미 있는 "메인넷 또는 테스트넷" 확인 내용과 다릅니다 — 추측성 요약이라 신뢰 안 함. 테스트넷 제출이 실제로 요건을 충족하는지 대시보드 원문을 한 번 더 확인하는 걸 권장합니다.
9. ~~Go-to-market 초안의 가정~~ — 검토함 (2026-10-05): Step 2에 "baseline agent bot을 로드맵에서 가져와 배포"라는 문장이 있었는데, 2026-10-04에 baseline 에이전트를 프로토콜 범위에서 뺀 결정과 어긋나서 "우리가 직접 locking 가능한 간단한 전략으로 첫 볼트를 운영한다"로 고쳤습니다. 나머지 가정(거래소 어댑터 우선순위, 직접 운영 후 개방, 운용자 성과보수 공유 미확정)은 기술적으로 현재 구현과 일치해서 그대로 받아들여도 됩니다.
10. 데모 영상에 Batch·Privacy 장면을 넣을지. 본편이 이미 2분 50초라 넣으려면 다른 장면을 줄여야 합니다 (`demo-video-script.md`의 선택 장면).
11. ~~공개 데모를 새 컨트랙트로 재배포할지~~ — 재배포 완료(2026-10-05 08:08 UTC). 남은 것은 오라클 대기 주기입니다. 공개 데모의 가장 엄격한 mandate는 mark age 10초라, 마지막 가격 뒤 30초가 지나면 누구나 `freezeUnobservable()`로 동결할 수 있습니다. 접속자가 없을 때도 30초 안에 갱신하면 하루 약 16 MON이 들어서, 지금 값(`ORACLE_IDLE_SECONDS=3600`)을 유지하고 일부러 동결된 경우는 기존 자동 재배포로 복구되게 두는 것을 추천합니다. (@jiwon000 확인)

## 글과 영상에서 지킬 것

- Monad를 쓰는 이유는 가격 기준 시각(mark age) 논리 하나로 말합니다. 조건이 요구할 수 있는 가격의 신선도는 블록 간격이 허락하는 만큼입니다. 속도나 비용 일반론은 쓰지 않습니다.
- 12초 블록 비교는 로컬 빌드에만 있습니다. 12초 모드에서도 가격 갱신 직후 몇 초는 주문이 통과하므로 "전혀 통과하지 못한다"고 쓰지 않습니다.
- 없는 실적(사용자 수, 파트너, 인터뷰)은 쓰지 않습니다. 구현하지 않은 것은 계획으로 적습니다.
- 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣는다는 점을 밝힙니다.
- Privacy 화면의 통계는 공개된 볼트 가격에서 계산합니다. 비공개 데이터를 보호한다고 말하지 않습니다.
- 영상과 화면 캡처에 니모닉, `.env`, `?admin=` 주소가 보이면 안 됩니다.

# 제출 준비 현황

> Team working notes for the Monad Metropolis submission, in Korean. The English texts entered in the submission form are the three `.txt` files in this folder.

Monad Metropolis 해커톤 Track 1 (Onchain Finance & Trading) 제출까지의 상태판입니다. 제출 폼에 넣은 글의 원본과 영상 대본 초안도 이 폴더에 있습니다. 기능이 어디까지 구현됐는지는 루트 [README](../../README.md)의 "다음 작업"과 Roadmap이 원본이고, 이 문서는 제출에 필요한 일만 다룹니다.

- 마감: 2026-10-13 23:59 ET (한국 시각 2026-10-14 12:59)
- 마지막 갱신: 2026-10-05
- 제출 폼: <https://hackathon.monad.xyz/project?tab=submission> (팀 계정 로그인 필요)
- 담당은 GitHub 계정으로 적습니다 (@jiwon000, @yahamang)

## 요약

- 제출 폼 체크리스트 5개 중 4개가 끝났습니다. 남은 하나는 영상 2개의 링크입니다.
- 공개 데모 <https://mandate-e4kb.onrender.com> 은 동작합니다. 다만 2026-10-05 09:29 KST 기준으로 커밋 `ea70611`을 서빙하고 있어, 그 뒤에 올린 커밋(라이브 모드의 Batch·Privacy)은 아직 배포되지 않았습니다.
- 공개 데모에 Batch·Privacy 화면이 보이려면 두 가지가 필요합니다. 새 커밋 배포, 그리고 BatchAllocator·MandateRegistry가 들어간 테스트넷 배포 기록입니다. 절차는 아래 "공개 데모 운영 메모"에 있습니다.
- 영상 2개는 아직 녹화하지 않았습니다. 대본 초안이 이 폴더에 있습니다.

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
| 1 | 브랜치 `docs/roadmap-feedback-0923`의 main 대상 PR 리뷰와 머지. PR #8 뒤에 올린 커밋이 들어 있음: 라이브 모드의 배처와 DP 리포터, 구 배포 기록에서의 부팅, 리셋 추적 수정, 문서 | @jiwon000 리뷰 | PR 열림 |
| 2 | Render에 새 커밋 배포 | @jiwon000 (Render 계정) | 대기 |
| 3 | 테스트넷 재배포로 BatchAllocator·MandateRegistry가 들어간 `web/deployments/10143.json`을 만들어 커밋. README 주소 표에 두 행 추가 | 누가 할지 정해야 함 | 미정 |
| 4 | 데모 영상 녹화와 업로드, 폼에 링크 입력 | 팀 | 미착수 |
| 5 | 피치 영상 녹화와 업로드, 폼에 링크 입력. 대본의 팀 소개 줄 채우기 | 팀 | 미착수 |
| 6 | 아래 "정해야 할 것" 정리 | 팀 | 진행 중 |
| 7 | 제출 전 최종 점검: 공개 데모에서 `judge-access.txt`의 1~11단계를 그대로 따라 하기, README의 수치와 주소 대조, 폼 "REVIEW ENTRY" | 팀 | 2번과 3번 뒤 |

## 공개 데모 운영 메모

설정값과 안전장치의 원본은 루트 README의 "라이브 테스트넷 데모"(영문 "Live testnet demo") 절입니다. 여기에는 지금 호스팅 상태에서 알아 둘 것만 적습니다.

- 호스트는 Render 웹 서비스이고, 브랜치 `docs/roadmap-feedback-0923`에서 빌드해 라이브 모드(chainId 10143)로 돕니다.
- 현재 빌드는 `ea70611`입니다. 2026-10-05 09:29 KST에 공개 데모의 `/app.js`를 커밋별 파일과 대조했습니다. 그 뒤 커밋은 push한 뒤에도 반영되지 않았으므로 자동 배포가 꺼져 있는 것으로 보입니다. Render 대시보드에서 수동 배포가 필요합니다.
- 공개 데모에 Batch·Privacy 화면이 없는 이유는 둘입니다. 새 빌드가 배포되지 않았고, 커밋된 `web/deployments/10143.json`이 두 컨트랙트가 생기기 전의 배포 기록입니다. 서버는 그런 기록에서도 부팅하고 두 화면만 숨깁니다. 로컬 빌드(`npm run web`)에는 두 화면이 모두 있습니다.
- Render의 파일시스템은 재시작과 재배포 때 초기화됩니다. 리셋으로 서버가 새로 쓴 배포 기록은 사라지고, 서버는 커밋된 `10143.json`으로 돌아갑니다. 그래서 Batch·Privacy를 공개 데모에 고정하려면 새 배포 기록을 커밋해야 합니다.
- 대기 중인 의향, claim 증명, 리포터 표본은 메모리에만 있습니다. 재시작하면 사라집니다.
- 공개 데모의 페이지나 `/api`를 열면 오라클이 60초 동안 5초 간격으로 가격을 갱신하고, 그만큼 배포 계정의 테스트넷 MON을 씁니다. 상태 확인은 필요한 만큼만 합니다. 배포 계정 잔액은 2026-10-05 11:02 KST에 약 31.4 MON이었습니다.
- 서버가 재시작할 때마다 재배포가 한 번 일어나고 약 2.2~2.9 MON이 듭니다. 커밋된 `10143.json`의 볼트 4개 중 3개가 이미 Frozen이라, 서버가 그 기록으로 부팅하면 첫 방문자가 떠날 때 자동 리셋이 돕니다. 체인 기록으로 확인한 재배포는 10-04 20:04, 10-05 09:00, 10:45 KST 세 번입니다. 뒤의 두 번은 직전 장부의 볼트가 모두 Active였으므로 방문자가 아니라 재시작 때문입니다. 10-04 20:42부터 10-05 09:00까지는 트랜잭션이 하나도 없었으므로 그 사이 서버가 잠들어 있었던 것으로 보입니다.
- 서버가 깨어 있으면 접속이 없어도 오라클이 300초마다 가격을 갱신합니다. 측정치는 시간당 약 0.066 MON, 하루 약 1.6 MON입니다. 잔액 31.4 MON에서 자동 리셋 하한 3 MON까지 남은 여유는 재시작 약 10회, 또는 상시 가동 약 17일 분량입니다. 심사 기간까지 버티려면 테스트넷 MON을 더 받거나 아래 "정해야 할 것" 2번을 정해야 합니다.
- Privacy 화면의 ε 누적 한도는 release 100회 분량이고 배포마다 새로 시작합니다. 심사 기간에 한도에 가까워지면 재배포합니다.

### 테스트넷 재배포 절차 (남은 일 3번)

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

1. 테스트넷 재배포를 누가 언제 할지 (남은 일 3번).
2. Render가 push마다 자동 배포하는지, 요금제가 무접속 시 서버를 재우는지. 체인 기록으로는 재우는 것으로 보이고, 깨어날 때마다 재배포 비용 약 2.5 MON이 나갑니다 ("공개 데모 운영 메모" 참고). 재시작 재배포는 코드로 막았습니다 (2026-10-05, `web/live-recover.mjs`). 서버가 부팅할 때 체인에서 가장 최근 장부를 찾아 그 장부로 시작합니다. 테스트넷에서 읽기만 해서 확인했고, 41초 만에 10:45 KST 장부를 찾았습니다. Render에 이 브랜치를 배포해야 적용됩니다. 남은 선택은 둘입니다. 환경변수 `ORACLE_IDLE_SECONDS`를 3600으로 올려 깨어 있을 때 대기 비용을 하루 약 0.13 MON으로 줄이기, 테스트넷 MON을 더 받아 두기. 부팅이 최대 1분쯤 늘어나는데 Render가 그 사이 포트를 기다려 주는지는 확인하지 못했습니다. 문제가 되면 `RECOVER_BOOK=0`으로 끕니다. (@jiwon000 확인)
3. 외부 감사 문구 (2026-10-05 정리). README 세 군데(한국어 "다음 작업", 영문 구현 현황 문단, 영문 Roadmap 12번)를 "외부 감사는 아직 받지 않았습니다"로 맞췄습니다. 제출 Description의 "No external audit has been completed."와 같은 뜻입니다. 지금까지의 검토는 `docs/security-review-2026-10-04.md`의 내부 리뷰입니다. 진행 중인 외부 감사가 있다면 맡은 곳과 범위를 README에 적습니다. (@jiwon000 확인)
4. Batch 화면 제목 (2026-10-05 정리). "Anyone can settle, once an epoch ends"는 컨트랙트와 달랐습니다. `settleEpoch()`는 batcher 주소만 부를 수 있습니다. 제목을 "Anyone can ask for settlement; only the batcher sends it"로 바꿨습니다. 누구나 버튼을 누를 수 있고 서버가 batcher로서 보낸다는 실제 동작과 같습니다.
5. README "AI tool disclosure"는 `Co-Authored-By` 트레일러가 있는 커밋을 기준으로 적혀 있습니다. 트레일러 없이 AI 도구를 쓴 커밋이 있으면 그 절에 한 줄을 더합니다. (@jiwon000 확인)
6. 한 줄 설명의 뒷부분 "market signals published with scoped differential privacy"를 그대로 둘지. 지금 게시하는 것은 공개된 볼트 통계라서 "market signals"가 더 넓게 읽힐 수 있습니다. 대안: "Back autonomous trading agents without custody: the agent can only execute, and every order must pass on-chain risk terms locked before the first deposit."
7. DP 리포터는 Laplace 스케일 하나를 평균, Sharpe, 최대 낙폭에 같이 씁니다. 그래서 화면의 ε는 평균에 대해서만 정확합니다. 제출 글에는 그렇게 적었습니다. 코드를 고칠지 지금 문구로 둘지 정합니다.
8. Sponsor bounty를 추가할지. 주제가 가까운 것은 Perpl "Best Analytics / Risk Tool", Perpl "Best use of Perpl's API", Monad Foundation "Best Community Team Project"입니다. 각 bounty의 요건은 아직 확인하지 않았습니다.
9. Go-to-market 초안의 가정을 받아들일지. 첫 단계는 Monad의 실제 무기한선물 거래소 한 곳의 어댑터, 초기 볼트는 팀이 직접 운영, 수익 모델은 운용자 성과보수의 일부이고 미확정이라고 적었습니다.
10. 데모 영상에 Batch·Privacy 장면을 넣을지. 본편이 이미 2분 50초라 넣으려면 다른 장면을 줄여야 합니다 (`demo-video-script.md`의 선택 장면).

## 글과 영상에서 지킬 것

- Monad를 쓰는 이유는 가격 기준 시각(mark age) 논리 하나로 말합니다. 조건이 요구할 수 있는 가격의 신선도는 블록 간격이 허락하는 만큼입니다. 속도나 비용 일반론은 쓰지 않습니다.
- 12초 블록 비교는 로컬 빌드에만 있습니다. 12초 모드에서도 가격 갱신 직후 몇 초는 주문이 통과하므로 "전혀 통과하지 못한다"고 쓰지 않습니다.
- 없는 실적(사용자 수, 파트너, 인터뷰)은 쓰지 않습니다. 구현하지 않은 것은 계획으로 적습니다.
- 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣는다는 점을 밝힙니다.
- Privacy 화면의 통계는 공개된 볼트 가격에서 계산합니다. 비공개 데이터를 보호한다고 말하지 않습니다.
- 영상과 화면 캡처에 니모닉, `.env`, `?admin=` 주소가 보이면 안 됩니다.

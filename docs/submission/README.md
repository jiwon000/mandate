# 제출 준비 현황

> Team working notes for the Monad Metropolis submission, in Korean. The English texts entered in the submission form are the three `.txt` files in this folder.

Monad Metropolis 해커톤 Track 1 (Onchain Finance & Trading) 제출까지의 상태판입니다. 제출 폼에 넣은 글의 원본과 영상 대본 초안도 이 폴더에 있습니다. 기능이 어디까지 구현됐는지는 루트 [README](../../README.md)의 "현재 상태", "한계"와 Roadmap이 원본이고, 이 문서는 제출에 필요한 일만 다룹니다.

- 마감: 2026-10-13 23:59 ET (한국 시각 2026-10-14 12:59)
- 마지막 갱신: 2026-10-11
- 제출 폼: <https://hackathon.monad.xyz/project?tab=submission> (팀 계정 로그인 필요)
- 담당은 GitHub 계정으로 적습니다 (@jiwon000, @yahamang)

## 요약

- 영상 세 편(데모, 피치, Perpl 바운티)을 10-11에 다 만들었습니다. 남은 일은 업로드, 폼에 링크 세 개 입력, 최종 점검 뒤 "REVIEW ENTRY"입니다.
- 제출 폼은 영상 링크 칸만 비어 있습니다. 나머지 칸은 10-11에 저장소 파일과 맞춰 다시 저장했고, 저장 뒤 다시 읽어 일치를 확인했습니다.
- 공개 데모 <https://mandate-e4kb.onrender.com> 은 2026-10-10 16:24 UTC에 배포한 테스트넷 장부(노이즈 서약이 들어간 MandateRegistry, guard `0xa8CD7431…`)로 돌고 있습니다. 10-11 Render 재배포 뒤 새 Market 화면, 오라클 5초 간격, `/api/reporter/status`의 `noisePledges: true`를 확인했습니다.
- 노이즈 서약은 공개 데모에서 실측했습니다(2026-10-11). epoch 1은 게시 직전 서약이라 `late-pledge`, epoch 2부터 `verified`(서약 블록 70015012, 데이터 창 시작 70015534). 검증은 `contracts/script/verify-noise.mjs`.
- 공개 데모는 방문자가 볼트를 동결하면 스스로 새 장부를 배포합니다(`AUTO_RESET_MIN_FROZEN=1`). 그래서 지금 장부(2026-10-11 04:50 UTC 배포, 10-11 확인)의 주소는 README "Recorded run on Monad testnet" 표(10-10 16:24 UTC 장부)와 다릅니다. 지금 주소는 공개 데모의 `/api/deployment`에서 볼 수 있고, 표의 장부는 체인에 그대로 남아 있습니다.
- 영상 파일은 저장소에 넣지 않습니다. 아래 "영상" 절에 길이와 폼 칸을 적었습니다.

## 이 폴더의 파일

| 파일 | 내용 |
| --- | --- |
| [`description.txt`](description.txt) | 폼 "Description"에 넣을 영문 본문. 7,947자 (한도 8,000자) |
| [`go-to-market.txt`](go-to-market.txt) | 폼 "Go-to-market and user acquisition strategy"에 넣을 영문 본문. 6,963자 (한도 8,000자) |
| [`judge-access.txt`](judge-access.txt) | 폼 "Judge access instructions"에 넣을 영문 본문. 6,039자 (한도 8,000자) |
| [`demo-video-script.md`](demo-video-script.md) | Technical demo video (3분 이하) 대본 초안 |
| [`pitch-video-script.md`](pitch-video-script.md) | Pitch video (2분 이하) 대본 초안. 팀 소개 줄은 영상에서 채움 |
| [`perpl-bounty-video-script.md`](perpl-bounty-video-script.md) | Perpl 바운티 영상(2분 이하) 대본 |
| [`demo-video/`](demo-video/README.md) | 데모 영상 녹화·합성 스크립트. 10-11 최종본을 만든 판 |
| [`club-deck/`](club-deck/README.md) | HYBLOCK 학회 발표 덱 (PDF와 원본). 제출물 아님 |
| [`mandate-logo.png`](mandate-logo.png) | 폼에 올린 로고, 1024×1024. 10-11에 새 화면의 보라색 M 마크로 교체 |
| [`mandate-logo.source.html`](mandate-logo.source.html) | 로고 원본 (HTML) |

세 `.txt` 파일은 2026-10-11에 고쳤고(카드형 Market 문구, 노이즈 서약, 테스트 개수 삭제), 같은 날 폼에 다시 붙여 넣어 일치를 확인했습니다. 폼의 글을 바꿀 때는 이 폴더의 파일을 먼저 고치고 그 내용을 폼에 붙여 넣습니다. 그래야 폼과 저장소가 어긋나지 않습니다.

글과 대본은 AI 도구(Claude Code)로 쓴 초안입니다. Go-to-market의 가정과 대본의 문장은 팀이 읽고 확정해야 합니다.

## 제출 요건 (공식 규정)

출처는 해커톤 대시보드의 Rules & Guidelines 4.1절과 9절입니다 (2026-09-03 갱신본, 2026-10-04 확인). 한 팀이 한 트랙에 프로젝트 하나를 냅니다. 심사 항목은 다섯 개이고 각 20%입니다: Product Quality & Completeness, Technical Excellence, Monad Integration, Track Fit & Problem Relevance, Innovation & Impact.

| 요건 | 상태 | 비고 |
| --- | --- | --- |
| 공개 GitHub 저장소: 전체 소스, 설치법 README, 오픈소스 라이선스, 외부 코드 출처, 빌드 기간의 커밋 이력 | 충족 | MIT `LICENSE`, README "Third-party code" |
| README에 AI 코딩 도구 사용 고지 | 충족 | README "AI tool disclosure". 아래 "정해야 할 것" 5번 참고 |
| 데모 영상: 3분 이하, 공개 링크(YouTube, Loom, Vimeo), 실제 동작과 Monad 상호작용 장면 | 영상 완성, 업로드 남음 | 10-11 공개 데모 녹화본, 영어 2분 26초. 공개 링크로 올려 폼에 입력 |
| Monad 메인넷 또는 테스트넷 배포, 컨트랙트 주소 또는 트랜잭션 해시 | 충족 | README "Recorded run on Monad testnet"에 컨트랙트 주소 11개와 트랜잭션 해시 |
| Monad를 쓰는 이유 설명 | 초안 있음 | `description.txt`. 가격 기준 시각(mark age) 논리 |
| 문서: 프로젝트 설명, 아키텍처, 기술 스택, 설치와 배포 방법 | 충족 | 루트 README |
| 플랫폼 제출 | 영상 링크만 남음 | 아래 표 |

## 제출 폼

폼의 체크리스트는 Primary track, Project details, Project logo, Live product, Demo and pitch videos 다섯 개입니다. 마감 전까지 저장하고 고칠 수 있습니다. "REVIEW ENTRY" 버튼은 아직 누르지 않았습니다. 영상 링크까지 넣은 뒤 팀이 같이 확인하고 누릅니다.

| 항목 | 필수 | 조건 | 상태 |
| --- | --- | --- | --- |
| Primary track | 필수 | 1개 선택 | 완료: Onchain Finance & Trading |
| Project logo | 필수 | PNG, JPG, WEBP. 2 MB 이하, 500 px 이상 | 완료: `mandate-logo.png` (10-11 교체) |
| Project name | 필수 | 120자 | 완료: `Mandate` |
| One-line description | 필수 | 200자 | 완료: README 영문 첫 줄 문구 (139자). "정해야 할 것" 6번 참고 |
| Description | 필수 | 8,000자 | 완료: `description.txt` |
| Go-to-market and user acquisition strategy | 필수 | 8,000자 | 완료: `go-to-market.txt`. 팀 확인 필요 |
| GitHub repository | 필수 | 공개 저장소 | 완료: `https://github.com/jiwon000/mandate` |
| Live product | 필수 | https 링크. Monad 메인넷 또는 테스트넷에서 동작 | 완료: `https://mandate-e4kb.onrender.com/` |
| Technical demo video | 필수 | 3분 이하. 동작하는 제품. 슬라이드와 코드 설명 불가 | 영상 완성(2분 26초), 링크 입력 남음 |
| Pitch video | 필수 | 2분 이하. 팀 소개, 문제, 만드는 이유 | 영상 완성(1분 42초), 링크 입력 남음 |
| Judge access instructions | 선택 | 8,000자 | 완료: `judge-access.txt` |
| Sponsor bounties | 선택 | 트랙 선택 뒤 추가 | Perpl "Best use of Perpl's API" 추가. 시스템 링크 칸 완료(`docs/perpl-adapter.md#agent-runs`), 영상 완성(1분 37초), 영상 링크 입력 남음 |
| Product advertisement, X profile | 선택 | 심사와 무관 | 비어 있음 |

## 영상

2026-10-11에 만든 최종본입니다. 모두 1280×720이고 자막이 들어 있습니다. 파일은 저장소에 넣지 않고 팀이 따로 보관합니다.

| 영상 | 길이 | 폼 칸 | 만든 방법 |
| --- | --- | --- | --- |
| 데모 (영어) | 2분 26초 | Technical demo video | 공개 데모 녹화 + 내레이션 ([`demo-video/`](demo-video/README.md)) |
| 피치 (영어) | 1분 42초 | Pitch video | 슬라이드 + 내레이션 |
| Perpl 바운티 (영어) | 1분 37초 | Perpl 바운티의 영상 칸 | 10-10 에이전트 실행 화면과 `docs/perpl-adapter.md`의 Agent runs 표 + 내레이션 |
| 데모, 피치 (한국어) | 2분 39초, 1분 55초 | 없음 | 같은 구성의 한국어판. 학회 공유용 |

내레이션은 모두 합성 음성(`edge-tts`)입니다. Perpl 영상의 내레이션은 [`perpl-bounty-video-script.md`](perpl-bounty-video-script.md)에 있습니다.

## 남은 일

| 순서 | 일 | 담당 | 상태 |
| --- | --- | --- | --- |
| ~~1~~ | ~~브랜치 `docs/roadmap-feedback-0923`의 main 대상 PR 리뷰와 머지~~ | @jiwon000 | 완료 (PR #9 머지됨) |
| ~~2~~ | ~~Render에 새 커밋 배포~~ | @jiwon000 | 완료 (`949d258` 배포, `ORACLE_IDLE_SECONDS=3600` 설정) |
| ~~3~~ | ~~README 주소 표에 BatchAllocator·MandateRegistry 행 추가, `10143.json` 갱신~~ | @jiwon000 | 완료 (2026-10-05 07:08:55 UTC 장부로 갱신) |
| ~~2-1~~ | ~~브랜치의 10-05 오후 커밋(Perpl 로드맵, 동결 규칙 설계와 구현)을 main에 올리는 새 PR 리뷰와 머지~~ | @yahamang | 완료 (PR #10 머지됨, CI 퍼즈 테스트 통과) |
| ~~2-2~~ | ~~공개 데모를 새 컨트랙트로 전환 (Render 배포 → 관리자 `Reset demo` → 주소 표와 `10143.json` 갱신)~~ | @jiwon000, @yahamang | 완료 (2026-10-05 08:08 UTC 장부) |
| ~~3-1~~ | ~~제출 폼 Description을 `description.txt`와 다시 맞추기. 한도에 맞게 9,565자에서 7,956자로 줄여 저장, One-line description도 함께 저장~~ | 팀 | 완료 (2026-10-05) |
| ~~3-2~~ | ~~10-06에 고친 `description.txt`, `go-to-market.txt`, `judge-access.txt`를 폼 세 칸에 다시 붙여 넣고, 저장 뒤 다시 읽어 일치 확인~~ | 팀 | 완료 (2026-10-06, 세 칸 모두 파일과 일치) |
| ~~3-3~~ | ~~10-11에 고친 세 `.txt`를 폼에 다시 붙여 넣고 일치 확인. 로고 교체~~ | 팀 | 완료 (2026-10-11) |
| 4 | 데모 영상 업로드, 폼에 링크 입력 | @jiwon000 | 영상 완성 (10-11 공개 데모 녹화). 업로드 남음 |
| 5 | 피치 영상 업로드, 폼에 링크 입력 | @jiwon000 | 영상 완성 (10-11). 업로드 남음 |
| 5-1 | Perpl 바운티 영상 업로드, 폼의 바운티 영상 칸에 링크 입력 | @jiwon000 | 영상 완성 (10-11). 업로드 남음 |
| 6 | 아래 "정해야 할 것" 정리 | 팀 | 진행 중 |
| 7 | 제출 전 최종 점검: 공개 데모에서 `judge-access.txt`의 1~9단계(선택 10~14단계)를 그대로 따라 하기, 올린 영상 링크가 로그인 없이 열리는지 확인, 폼 "REVIEW ENTRY" | 팀 | 4, 5, 5-1번 뒤 |

## 공개 데모 운영 메모

설정값과 안전장치의 원본은 루트 README의 "라이브 테스트넷 데모"(영문 "Live testnet demo") 절입니다. 여기에는 지금 호스팅 상태에서 알아 둘 것만 적습니다.

- 호스트는 Render 웹 서비스이고, 라이브 모드(chainId 10143)로 돕니다. 2026-10-06 재배포 뒤 서빙되는 `app.js`는 main과 같습니다.
- `web/live-recover.mjs`가 부팅할 때 체인에서 가장 최근 완성 장부를 찾아 쓰므로, 커밋된 `10143.json`이나 재배포 가능성에 의존하지 않습니다.
- 공개 데모에 Batch·Privacy·Launch 화면이 보입니다. README "Recorded run on Monad testnet"과 `web/deployments/10143.json`에는 2026-10-10 16:24 UTC 장부가 적혀 있고, 공개 데모는 그 뒤 자동 재배포로 새 장부(10-11 04:50 UTC, 10-11 확인)를 씁니다. 공개 데모에서 Launch는 브라우저 지갑으로만 할 수 있습니다(가스는 방문자 지갑 부담). 그 전 장부들(10-07 04:30, 10-06 04:18, 10-05 08:08·09:47 UTC 등)은 체인에 남아 있습니다.
- Render의 파일시스템은 재시작과 재배포 때 초기화되지만, 빌드는 그때마다 배포 계정의 트랜잭션을 거꾸로 훑어 가장 최근 완성 장부로 부팅하므로(읽기만 하고 MON은 들지 않음, 테스트넷에서 약 40초) 더 이상 재시작마다 재배포가 일어나지 않습니다.
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
3. ~~외부 감사 문구~~ — 해결됨: 진행 중인 외부 감사 없음 확인. README 세 군데(한국어 "한계", 영문 구현 현황 문단, 영문 Roadmap 12번)는 "외부 감사는 아직 받지 않았습니다"로 이미 일치합니다. 지금까지의 검토는 `docs/security-review-2026-10-04.md`의 내부 리뷰뿐입니다. 별도로 만든 발표 슬라이드(claude.ai 아티팩트)에 "외부 감사 진행 중"이라고 잘못 적혀 있던 걸 발견해 같은 문구로 고쳤습니다.
4. ~~Batch 화면 제목~~ — 완료 확인: `web/index.html`에 "Anyone can ask for settlement; only the batcher sends it"로 이미 반영돼 있습니다.
5. ~~AI 사용 공개 문구~~ — 해결됨 (2026-10-06): 트레일러 없는 병합 외 커밋 8개(2026-09-20~09-22, @jiwon000 7개, @yahamang 1개)도 대부분 Claude로 작성했다고 팀이 확인했습니다. README "AI tool disclosure" 절에 "The eight earlier commits without a trailer (2026-09-20 to 09-22) were also written with AI coding tools, mostly Claude."를 추가했습니다.
6. ~~한 줄 설명의 "market signals" 문구~~ — 해결됨 (2026-10-05): "시장 신호"가 실제로 게시하는 것(공개된 볼트 성과 통계)보다 넓게 읽혀서, README 한국어·영문 첫 줄을 "published performance stats carry a verifiable, on-chain differential-privacy budget" (공개된 성과 통계는 온체인에서 검증 가능한 차등 프라이버시 예산 안에서 게시됩니다)로 바꿨습니다. 폼의 "One-line description"도 이 문구로 다시 붙여넣어야 합니다 (영문 172자, 한도 200자).
7. ~~DP 리포터의 단일 Laplace 스케일 문제~~ — 결정됨 (2026-10-05): 코드는 그대로 둡니다. Sharpe와 최대 낙폭은 clip된 입력에서의 실제 민감도(sensitivity)가 아직 유도되지 않았는데, 지금 시간 압박 속에서 직접 새 수식을 유도하면 틀릴 위험이 검증 안 된 주장을 하나 더 만드는 것과 같습니다 — "평균에 대해서만 정확하다"고 솔직하게 범위를 좁히는 쪽이 더 안전합니다. 이미 `description.txt`에 정확히 그렇게 적혀 있었고, README "Published ε vs Privacy Simulator" 절과 `reporter/reporter.mjs`의 코드 주석에도 같은 설명을 추가해 세 곳이 일치하도록 맞췄습니다.
8. ~~Sponsor bounty를 추가할지~~ 결정 (2026-10-11): Perpl "Best use of Perpl's API"에 냅니다. 폼의 시스템 링크 칸을 채웠고 영상(1분 37초)을 만들었습니다. 아래는 저장소 기준 사실 정리입니다 (2026-10-06). 바운티 이름과 금액(Perpl "Best use of Perpl's API" $5,000, "Best Analytics / Risk Tool" $3,000, 마감 10-13)은 10-05 웹 검색 결과라, 세부 요건은 대시보드 원문으로 확인해야 합니다.
   - "Best use of Perpl's API": `PerplAdapter`가 Perpl 테스트넷 거래소의 실제 컨트랙트와 포크에서 개설부터 출금까지 동작합니다 ([`docs/perpl-adapter.md`](../perpl-adapter.md), 10회 연속 통과). 2026-10-06에 어댑터를 Monad 테스트넷에 배포해 Perpl 테스트넷 거래소에서 왕복 1회, 이어서 에이전트 스크립트 5회 실행(10-06 3회, 10-10 2회)으로 체결 20건, 한도 초과 거부 9건을 기록했습니다(README). 공개 데모는 여전히 mock 거래소입니다.
   - "Best Analytics / Risk Tool": RiskGuard 조건 검사, 텀시트, 변동성 조항, DP 리포터가 주제에 맞을 수 있습니다. Perpl 데이터 연동이 필수인지는 확인하지 못했습니다.
   - 둘 다 추가해도 본 트랙 심사에는 영향이 없습니다 (규정상 바운티는 트랙 선택 뒤 추가하는 선택 항목).
9. ~~Go-to-market 초안의 가정~~ — 검토함 (2026-10-05): Step 2에 "baseline agent bot을 로드맵에서 가져와 배포"라는 문장이 있었는데, 2026-10-04에 baseline 에이전트를 프로토콜 범위에서 뺀 결정과 어긋나서 "우리가 직접 locking 가능한 간단한 전략으로 첫 볼트를 운영한다"로 고쳤습니다. 나머지 가정(거래소 어댑터 우선순위, 직접 운영 후 개방, 운용자 성과보수 공유 미확정)은 기술적으로 현재 구현과 일치해서 그대로 받아들여도 됩니다.
10. ~~데모 영상에 Batch·Privacy 장면을 넣을지~~ 결정 (2026-10-06): 넣지 않습니다. 본편이 2분 45초라 여유가 없고, 두 화면은 `judge-access.txt` 선택 단계 12·13번에서 심사자가 직접 해 볼 수 있습니다.
11. ~~오라클 대기 주기~~ 결정 (2026-10-05): `ORACLE_IDLE_SECONDS=3600`을 유지합니다. 공개 데모의 가장 엄격한 mandate는 mark age 10초라, 접속자가 없을 때 누구나 `freezeUnobservable()`로 동결할 수 있습니다. 30초 안에 계속 갱신하면 하루 약 16 MON이 들어서, 일부러 동결된 경우는 자동 재배포(`AUTO_RESET_MIN_FROZEN=1`)로 복구되게 둡니다. 심사 안내에는 첫 클릭에 `MarkTooOld`가 한 번 나올 수 있다고 적어 두었습니다.

## 글과 영상에서 지킬 것

- Monad를 쓰는 이유는 가격 기준 시각(mark age) 논리 하나로 말합니다. 조건이 요구할 수 있는 가격의 신선도는 블록 간격이 허락하는 만큼입니다. 속도나 비용 일반론은 쓰지 않습니다.
- 12초 블록 비교는 로컬 빌드에만 있습니다. 12초 모드에서도 가격 갱신 직후 몇 초는 주문이 통과하므로 "전혀 통과하지 못한다"고 쓰지 않습니다.
- 없는 실적(사용자 수, 파트너, 인터뷰)은 쓰지 않습니다. 구현하지 않은 것은 계획으로 적습니다.
- 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣는다는 점을 밝힙니다.
- Privacy 화면의 통계는 공개된 볼트 가격에서 계산합니다. 비공개 데이터를 보호한다고 말하지 않습니다.
- 영상과 화면 캡처에 니모닉, `.env`, `#admin=`·`?admin=` 주소가 보이면 안 됩니다.

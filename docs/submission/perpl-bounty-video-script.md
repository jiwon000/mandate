# Perpl 바운티 영상 대본 (Best use of Perpl's API)

- 제출 폼이 요구하는 것 두 가지
  1. 2분 이하 데모 영상. Perpl 위의 트레이딩 봇이나 자동화 시스템이 실제 온체인 활동을 하는 모습을 보여야 한다.
  2. 그 시스템 링크.
- 심사 기준은 안정적 실행, 리스크 관리, 수익성, 실제 온체인 활동이다. 이 영상은 리스크 관리와 온체인 활동에 집중한다. 수익성은 주장하지 않는다(테스트넷 소액, 규칙 기반 스크립트).
- 상태: 최종본 완성 (2026-10-11, Claude Code, 영어 1분 37초, 합성 음성과 자막). B안으로 10-10에 새로 실행한 화면(run 4)을 넣었고, 10-11에 Agent runs 표 장면과 끝 화면을 다시 찍었다. 아래 대본이 영상에 들어간 내레이션이다. 영상 파일은 저장소에 넣지 않는다.
- 근거 자료는 [`docs/perpl-adapter.md`](../perpl-adapter.md)의 Testnet deployment·Agent runs 절과 [`contracts/deployments/perpl-agent-10143.jsonl`](../../contracts/deployments/perpl-agent-10143.jsonl)이다.

## 링크 칸에 넣을 것

`https://github.com/jiwon000/mandate/blob/main/docs/perpl-adapter.md#agent-runs`

배포 주소, 실행 표, 체결·거부 tx 해시가 한곳에 있다. 볼트 주소(`0xD2FdA5382049FD399a84e660e2B06297b476e716`)의 익스플로러 링크는 영상 안에서 보여 준다.

## 녹화 방식

- **A안 (기본).** 10-06 실행 기록만으로 찍는다. 키가 필요 없고 지금 바로 할 수 있다.
- **B안 (선택).** 배포 키를 가진 팀원이 짧게 새로 실행하는 화면을 넣는다. "실제로 돌아간다"는 인상이 더 강하다.
  - 실행 명령: `TICK_SECONDS=60 MAX_TICKS=6 BREACH_EVERY=3 npm run agent:perpl` (`contracts/`에서, `PERPL_WALLET_FILE` 지정)
  - 필요한 것: 지갑에 MON 약 2개(체결 1건당 약 0.22 MON). 볼트에는 10-06 잔액이 남아 있어 `ALLOCATE`는 필요 없다.
  - 약 6분 걸린다. 터미널 출력과 익스플로러 새 tx를 찍는다.
  - 키 파일 내용이 화면에 나오지 않게 한다.

## 대본

| 시간 | 화면 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 0:00 | `docs/perpl-adapter.md` 주소 표 | Mandate puts a trading agent inside limits that are enforced on chain. For this bounty we deployed a Mandate vault and our Perpl adapter on Monad testnet, so the agent trades Perpl's real order book through the vault. | Mandate는 트레이딩 에이전트를 온체인에서 강제되는 한도 안에 둔다. 이 바운티를 위해 Monad 테스트넷에 볼트와 Perpl 어댑터를 배포했고, 에이전트는 볼트를 통해 Perpl 실제 오더북에서 거래한다. |
| 0:15 | `perpl-agent.mjs` 머리 주석 | The agent is a simple rule-based script, not an AI model. It follows a moving average of Perpl's BTC mark, and every few ticks it deliberately tries an order past the vault's two-hundred-dollar position cap. | 에이전트는 AI가 아닌 단순 규칙 기반 스크립트다. Perpl BTC 마크의 이동평균을 따르고, 몇 틱마다 일부러 볼트의 200달러 포지션 한도를 넘는 주문을 낸다. |
| 0:30 | 10-10 실행 화면 (틱별 마크, 마크 나이, 주문, 결과) | This is a live run, recorded on October tenth and sped up. Each tick reads Perpl's mark and how old it is. The agent goes long, then flips short on Perpl. When it tries the oversized order, the guard refuses it on chain. At the end, it closes the position. | 10월 10일에 녹화해 빠르게 돌린 실제 실행이다. 틱마다 Perpl 마크와 그 나이를 읽는다. 에이전트는 롱을 잡았다가 숏으로 바꾼다. 한도를 넘는 주문은 가드가 온체인에서 거부한다. 끝에 포지션을 닫는다. |
| 0:51 | 익스플로러: 그 실행의 체결 tx | Here is one of those fills on the explorer. The vault sent an immediate-or-cancel order to Perpl, after the guard checked size, leverage, drawdown and the age of Perpl's mark. | 그 체결 중 하나. 가드가 규모·레버리지·손실·마크 나이를 검사한 뒤 볼트가 Perpl에 IOC 주문을 보냈다. |
| 1:04 | 익스플로러: 거부 tx, status Fail | And here is the oversized order. It was mined, and it failed with the guard's error, position notional exceeded. No margin moved. | 한도 초과 주문. 블록에 들어갔고 가드의 `PositionNotionalExceeded` 에러로 실패했다. 증거금은 움직이지 않았다. |
| 1:16 | GitHub의 `docs/perpl-adapter.md` Agent runs 표 | The repo logs every run. Over five runs on October sixth and tenth, twenty orders filled, and all nine oversized orders were refused on chain. These are small testnet trades, and we make no profit claim. | 저장소에 모든 실행이 기록돼 있다. 10월 6일과 10일 다섯 번 실행에서 20건이 체결됐고 한도 초과 주문 9건은 모두 온체인에서 거부됐다. 테스트넷 소액 거래이고 수익은 주장하지 않는다. |
| 1:31 | 로고와 저장소 주소 | Any bot can trade on Perpl. Mandate makes one safe to fund. | 어떤 봇이든 Perpl에서 거래할 수 있다. Mandate는 그 봇에 안심하고 돈을 맡길 수 있게 한다. |

## 확인해 둘 것

- 익스플로러가 Cloudflare 확인을 띄우면 사람이 직접 통과한다.
- Perpl과 제휴했다고 말하지 않는다. 공개 데모(Render)는 mock 거래소라 이 영상에는 넣지 않는다.
- 수익을 냈다고 말하지 않는다. 체결 20건, 거부 9건은 `docs/perpl-adapter.md`의 Agent runs 표 합계다.
- 1:04 거부 tx는 status 0(Fail)으로 보인다. 화면에 에러명이 안 나오면 `perpl-agent-10143.jsonl`의 `"error": "PositionNotionalExceeded()"` 줄을 함께 보여 준다.

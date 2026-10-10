# Perpl 바운티 영상 대본 (Best use of Perpl's API)

- 제출 폼이 요구하는 것 두 가지
  1. 2분 이하 데모 영상. Perpl 위의 트레이딩 봇이나 자동화 시스템이 실제 온체인 활동을 하는 모습을 보여야 한다.
  2. 그 시스템 링크.
- 심사 기준은 안정적 실행, 리스크 관리, 수익성, 실제 온체인 활동이다. 이 영상은 리스크 관리와 온체인 활동에 집중한다. 수익성은 주장하지 않는다(테스트넷 소액, 규칙 기반 스크립트).
- 상태: 10-10 초안 (Claude Code), 녹화 전. 내레이션은 영어 약 230단어로 약 1분 40초.
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
| 0:00 | `docs/perpl-adapter.md` 주소 표 | Mandate puts a trading agent inside on-chain limits. For this bounty we connected it to Perpl on Monad testnet. PerplAdapter, our factory and a vault are deployed there, and the agent trades Perpl's real order book through the vault. | Mandate는 트레이딩 에이전트를 온체인 한도 안에 둔다. 이 바운티를 위해 Monad 테스트넷의 Perpl에 연결했다. 어댑터·팩토리·볼트가 배포돼 있고 에이전트는 볼트를 통해 Perpl 실제 오더북에서 거래한다. |
| 0:18 | `perpl-agent.mjs` 머리 주석 | The agent is a simple rule-based bot, not an AI model. It follows a moving average of Perpl's BTC mark and holds a small long or short. Every few ticks it deliberately tries an order past the vault's two-hundred-dollar position cap. | 에이전트는 AI가 아닌 단순 규칙 기반 봇이다. Perpl BTC 마크의 이동평균을 따라 작은 롱이나 숏을 든다. 몇 틱마다 일부러 볼트의 200달러 포지션 한도를 넘는 주문을 낸다. |
| 0:36 | 익스플로러: 체결 tx (`0xaa4004dc…3085`) | Here is a fill. The vault sends an immediate-or-cancel order to Perpl, and the guard checks size, leverage, drawdown and how old Perpl's mark is before Perpl ever sees it. | 체결 tx. 볼트가 Perpl에 IOC 주문을 보내고, Perpl이 보기 전에 가드가 규모·레버리지·손실·마크 나이를 검사한다. |
| 0:52 | 익스플로러: 거부 tx (`0xdbc5cf66…38a0`), status Fail, `PositionNotionalExceeded` | And here is the over-limit order. It was mined and refused on chain with the guard's named error. No margin moved. | 한도 초과 주문. 블록에 들어갔고 가드의 이름 붙은 에러로 온체인 거부됐다. 증거금은 움직이지 않았다. |
| 1:05 | `docs/perpl-adapter.md` Agent runs 표 | Over three runs on October sixth, ten orders filled and five were refused at the cap. Each run closed its position, and the vault ended at about the same equity it started with. These are small testnet trades, not sustained trading. | 10월 6일 세 번 실행에서 10건 체결, 5건이 한도에서 거부됐다. 매번 포지션을 닫았고 볼트 자산은 시작과 거의 같았다. 테스트넷 소액 거래이지 지속 운용은 아니다. |
| 1:22 | (B안이면 터미널 새 실행, 아니면 어댑터 코드 `maxAdverseLimitBps`) | The adapter adds its own safety: limits must stay within three percent of Perpl's mark, margin moves only during a trade, and anyone can freeze the vault and unwind it with reduce-only orders. | 어댑터 자체 안전장치: 지정가는 Perpl 마크의 3% 이내, 증거금은 거래 중에만 이동, 누구나 볼트를 동결하고 reduce-only 주문으로 정리할 수 있다. |
| 1:36 | 얼굴 또는 로고 | Any bot can trade on Perpl. Mandate makes one safe to fund. Thank you. | 어떤 봇이든 Perpl에서 거래할 수 있다. Mandate는 그 봇에 안심하고 돈을 맡길 수 있게 한다. |

## 확인해 둘 것

- 익스플로러가 Cloudflare 확인을 띄우면 사람이 직접 통과한다.
- Perpl과 제휴했다고 말하지 않는다. 공개 데모(Render)는 mock 거래소라 이 영상에는 넣지 않는다.
- 수익을 냈다고 말하지 않는다. "about the same equity"는 150 aUSD 할당, 3차 실행 종료 시 150.19 aUSD 기록에 근거한다.
- 0:52 거부 tx는 status 0(Fail)으로 보인다. 화면에 에러명이 안 나오면 `perpl-agent-10143.jsonl`의 `"error": "PositionNotionalExceeded()"` 줄을 함께 보여 준다.

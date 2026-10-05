# 피치 영상 대본 (제출 폼: Pitch video)

- 조건: 2분 이하. 팀 소개, 푸는 문제, 왜 만드는지.
- 상태: 초안 (2026-10-04 작성, 10-05 마지막 문단을 현재 구현에 맞춤). AI 도구(Claude Code)로 쓴 초안이고 녹화 전이다. 팀이 읽어 보고 고쳐 쓴다.
- 내레이션은 팀 소개 줄을 채우면 영어 약 270단어. 분당 140단어로 읽으면 약 1분 55초라 2분 한도에 여유가 거의 없다. 녹화해 보고 넘으면 0:12 문단에서 한 문장을 뺀다.
- 팀 소개 줄의 대괄호(이름, 소속)는 팀이 채운다.
- 사용자 수, 파트너, 인터뷰 같은 실적은 없으므로 말하지 않는다.

## 대본

| 시간 | 화면 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 0:00 | 말하는 사람 얼굴 또는 로고 | Hi. We are [이름] and [이름], from [소속]. We are building Mandate. | 팀 소개. 이름과 소속은 팀이 채운다. |
| 0:12 | 얼굴, 또는 Market 화면 | When you back a trading agent, you trust its operator twice. Not to take the money. And not to take more risk than they said. Today the only way to check either one is to ask: can I trust this trader? For software you did not write, that is a hard question to answer. | 트레이딩 에이전트에 돈을 맡기면 운용자를 두 번 믿어야 한다. 돈을 가져가지 않을 것, 말한 것보다 큰 위험을 지지 않을 것. 지금은 "이 트레이더를 믿을 수 있나"를 물을 수밖에 없고, 내가 쓰지 않은 소프트웨어에 대해 답하기 어렵다. |
| 0:35 | Agent 화면의 Risk limits 패널 | Mandate changes the question to: can I accept these terms? Capital sits in a vault the agent can trade and cannot withdraw. Leverage, drawdown and how fresh the price must be are locked on chain before the first deposit, and every order has to pass a guard that enforces them. | Mandate는 질문을 "이 조건을 받아들일 수 있나"로 바꾼다. 돈은 에이전트가 거래만 하고 인출은 못 하는 볼트에 있다. 레버리지, 손실 한도, 가격 신선도는 첫 예치 전에 온체인에 잠기고 모든 주문은 가드를 통과해야 한다. |
| 0:58 | Live Risk 화면의 FROZEN 상태 | If a vault falls past its drawdown limit, anyone can prove it on chain. The agent is frozen, the position is closed in public steps, and allocators can withdraw throughout. | 볼트가 손실 한도를 넘으면 누구나 온체인에서 증명할 수 있다. 에이전트는 동결되고 포지션은 공개 단계로 정리되며 투자자는 계속 인출할 수 있다. |
| 1:12 | 블록 주기 스위치 화면 | We build on Monad for one reason. A mandate can demand a fresh price, and a price on chain is only as fresh as the block interval. On twelve-second blocks a four-second term cannot be met: the price is already too old in the next block. | Monad 위에 만드는 이유는 하나다. 조건은 신선한 가격을 요구할 수 있는데 온체인 가격은 블록 간격만큼만 신선하다. 12초 블록에서는 4초 조건을 맞출 수 없다. 다음 블록에서 가격은 이미 너무 오래됐다. |
| 1:28 | 얼굴 | We are building this because we think people will hand capital to agents before anyone can vouch for them, and the limits should be code an allocator can read, not a promise. Today it runs on Monad testnet against a mock venue. Next come one real perpetuals venue, private reporting on the release layer we built, and an external audit before any real capital. Thank you. | 만드는 이유: 누가 보증해 주기 전에 사람들이 에이전트에 돈을 맡기게 될 것이라고 보고, 한도는 약속이 아니라 투자자가 읽을 수 있는 코드여야 한다. 지금은 모나드 테스트넷에서 mock 거래소로 돈다. 다음은 실제 무기한선물 거래소 한 곳, 지금 만든 공개 통계 릴리스 계층 위에 올릴 비공개 리포팅, 실자본 전 외부 감사. |

## 확인해 둘 것

- "왜 만드는지" 문단은 초안의 논리다. 팀의 실제 동기가 따로 있으면 그 문장으로 바꾼다.
- Monad 문단은 가격 기준 시각 논리 하나만 쓴다. 속도나 비용 일반론은 넣지 않는다.
- "the release layer we built"는 10-04에 구현된 MandateRegistry와 DP Reporter를 가리킨다. 지금은 공개된 볼트 가격 데이터에만 노이즈를 넣어 게시한다. 비공개 데이터 보호는 아직 없으므로 "private reporting"은 다음 단계로만 말한다.
- 화면 삽입이 번거로우면 얼굴만 찍어도 조건을 채운다. 폼은 팀, 문제, 이유만 요구한다.

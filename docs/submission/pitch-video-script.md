# 피치 영상 대본 (제출 폼: Pitch video)

- 조건: 2분 이하. 팀 소개, 푸는 문제, 왜 만드는지.
- 상태: 10-10 전면 재작성 (Claude Code 초안). 10-11에 이 대본을 바탕으로 영상을 만들었다(영어 1분 42초, 합성 음성). 영상의 문장은 대본과 조금 다를 수 있고, 팀 소개 줄은 영상에서 채웠다. 10-06 Perpl 테스트넷 체결을 반영했고, 아직 아무것도 보호하지 않는 비공개 리포팅 언급은 뺐다.
- 내레이션은 영어 약 255단어. 분당 140단어로 읽으면 약 1분 50초.
- 팀 소개 줄의 대괄호(이름, 소속)는 팀이 채운다.
- 사용자 수, 파트너, 인터뷰 같은 실적은 없으므로 말하지 않는다.

## 대본

| 시간 | 화면 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 0:00 | 얼굴 또는 로고 | Hi, we're [name] and [name] from [affiliation], and this is Mandate. | 팀 소개. 이름과 소속은 팀이 채운다. |
| 0:08 | 얼굴, 또는 Market 화면 | If you fund a trading agent you didn't write, you trust its operator twice: not to take the money, and not to take more risk than they promised. Today a risk limit is just a promise, and you find out it was broken after the loss. | 내가 쓰지 않은 에이전트에 돈을 넣으면 운용자를 두 번 믿는다. 돈을 가져가지 않을 것, 약속보다 큰 위험을 지지 않을 것. 지금 위험 한도는 약속일 뿐이고, 어겼다는 건 손실이 난 뒤에 안다. |
| 0:25 | Agent 화면의 조건 패널 | Mandate turns that promise into code. Capital sits in a vault the agent can trade but cannot withdraw from. Nineteen terms covering size, leverage, losses and price freshness are locked on chain before the first deposit. Every order is checked before it reaches the exchange, and an order over the limit fails. | 약속을 코드로 바꾼다. 돈은 에이전트가 거래만 하고 인출은 못 하는 볼트에 있다. 규모, 레버리지, 손실, 가격 신선도에 관한 19개 조건이 첫 예치 전에 잠긴다. 모든 주문은 거래소에 닿기 전에 검사되고 한도를 넘는 주문은 실패한다. |
| 0:50 | Live Risk 화면의 FROZEN 상태 | If losses cross the limit, anyone can freeze the vault and close the position in public steps for a small fee. Allocators keep their exit the whole time. | 손실이 한도를 넘으면 누구나 볼트를 동결하고 포지션을 공개 단계로 정리할 수 있고, 작은 수수료를 받는다. 투자자의 출금은 내내 열려 있다. |
| 1:03 | 블록 주기 화면 | Why Monad? A term can demand a price only a few seconds old, and a price on chain is only as fresh as the block interval. On Monad testnet our strictest vault requires a price under ten seconds old, and in eight checks in a row the price was one to five seconds old. | 왜 Monad인가. 조건은 몇 초 이내의 가격을 요구할 수 있는데 온체인 가격은 블록 간격만큼만 신선하다. Monad 테스트넷에서 가장 엄격한 볼트는 10초 이내 가격을 요구하고, 연속 8번 확인에서 가격 나이는 1~5초였다. |
| 1:25 | 얼굴 | Mandate doesn't make an agent trade better. It makes an agent nobody can vouch for safe to fund, within limits you can read before you deposit. Today it runs on Monad testnet against a mock exchange. Our Perpl adapter has already placed small trades on Perpl testnet, where over-limit orders were refused on chain. Next is an external audit, before any real money. Thank you. | Mandate는 에이전트를 더 잘 거래하게 만들지 않는다. 아무도 보증할 수 없는 에이전트에도, 예치 전에 읽을 수 있는 한도 안에서 안심하고 돈을 맡길 수 있게 한다. 지금은 모나드 테스트넷에서 mock 거래소로 돈다. Perpl 어댑터는 Perpl 테스트넷에서 소액 거래를 했고 한도를 넘는 주문은 온체인에서 거부됐다. 다음은 실자금 전 외부 감사. |

## 확인해 둘 것

- 소속을 HYBLOCK(한양대 블록체인 학회)으로 쓸지 팀이 정한다.
- Monad 문단은 가격 기준 시각 논리 하나만 쓴다. 속도나 비용 일반론은 넣지 않고, 12초 블록이 "전혀 통과하지 못한다"고도 말하지 않는다.
- Perpl은 연결한 거래소일 뿐 제휴가 아니다. 공개 데모는 mock 거래소에서 돈다는 문장을 빼지 않는다.
- "small fee"는 unwind 바운티(0.01%)다.
- 화면 삽입이 번거로우면 얼굴만 찍어도 조건을 채운다. 폼은 팀, 문제, 이유만 요구한다.

# 데모 영상 대본 (제출 폼: Technical demo video)

- 조건: 3분 이하. 동작하는 제품을 보여 줄 것. 슬라이드와 코드 설명은 불가. YouTube, Loom, Vimeo 같은 영상 호스트의 링크로 제출.
- 상태: 10-04 작성, 10-06 개편·녹화, 10-07 수정. AI 도구(Claude Code)로 쓴 초안이다. 팀이 읽어 보고 고쳐 쓴다.
- 10-07 수정 내용: 10-07 컨트랙트에 맞췄다. 하루 손실은 동결이 아니라 다음 UTC 날까지 일시정지, 가격이 끊겨 생긴 동결은 재개 가능, 출금 대기열(`requestRedeem`)이 생겼다. 장면 1:03에 넘었을 때의 세 갈래를, 장면 2:03에 출금 대기열을 넣었다. 길이를 맞추려고 장면 0:30의 조건 나열에서 두 개를 뺐다. 실제 녹화에 쓴 문장은 `demo-video/scenes.json`(영어)과 `scenes.ko.json`(한국어)이 기준이다.
- 10-06 개편 내용: 화면을 보여 주면서 프로젝트 전체를 설명하도록 바꿨다. 무엇을 하는 서비스인지, 누가 에이전트를 등록하는지, 조건이 무엇인지, 조건을 넘으면 무슨 일이 일어나는지를 장면 1~3에서 말한다. 슬라이드는 쓰지 않는다.
- 화면 문구는 저장소 `web/index.html`, `web/app.js` 기준이다. 화면이 바뀌면 이 대본도 맞춘다.
- 내레이션은 영어 약 390단어, 분당 140단어로 약 2분 50초. 트랜잭션을 기다리는 구간은 잘라 낸다. 3분을 넘으면 아래 "줄일 곳"부터 뺀다.

## 어디서 녹화하나

공개 주소 `https://mandate-e4kb.onrender.com`(Monad 테스트넷 10143)에서 녹화한다. 녹화 스크립트와 절차는 [`demo-video/README.md`](demo-video/README.md). 볼트가 동결되면 서버가 새 장부를 배포하므로, 녹화 뒤 저장소 README의 주소표를 확인한다.

장면 2:18의 12초/1초 갱신 비교는 로컬 빌드에서만 된다. 공개 주소 녹화에서는 이 장면 대신 탐색기 장면을 쓰고, Monad를 쓰는 이유는 마크 유효시간 논리로만 말한다.

## 녹화 전 준비

1. 네 볼트가 모두 Active, 가격 $2000인 초기 상태에서 시작한다. 로컬은 서버를 새로 띄우면 된다. 공개 주소는 재배포 직후가 가장 깨끗하다.
2. 페이지를 열고 10초쯤 기다린 뒤 시작한다. 공개 주소에서는 접속자가 없으면 가격 갱신이 느려져 첫 주문이 MarkTooOld로 거절될 수 있다.
3. 브라우저 창은 1280×720 이상, 확대 110~125%. 북마크 바와 다른 탭은 숨긴다.
4. 기다리는 구간은 잘라도 된다. 결과 화면을 바꾸거나 합성하지 않는다.

## 장면

| 시간 | 화면에서 하는 일 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 0:00 | Market 화면. 네 줄의 볼트와 한도 대비 수치를 천천히 보여 준다. | This is Mandate, a market where trading agents raise capital under terms a contract enforces. An allocator puts money into an agent's vault. The agent can trade that money and can never withdraw it. Its terms are locked on chain before the first deposit, and every order has to pass a risk guard that checks them. So the allocator stops asking "can I trust this trader?" and asks "can I accept these terms?" | Mandate는 트레이딩 에이전트가 컨트랙트가 강제하는 조건 아래 자금을 받는 시장이다. 투자자는 에이전트의 볼트에 돈을 넣는다. 에이전트는 그 돈으로 거래만 하고 인출은 절대 못 한다. 조건은 첫 예치 전에 온체인에 잠기고, 모든 주문은 그 조건을 검사하는 리스크 가드를 통과해야 한다. 그래서 질문이 "이 트레이더를 믿을 수 있나"에서 "이 조건을 받아들일 수 있나"로 바뀐다. |
| 0:30 | 헤더의 Launch. Balanced 프리셋을 누르고 입력 칸을 천천히 아래로 훑는다. 아래쪽 TERMS HASH를 보여 준다. 공개 주소에서는 제출하지 않는다. | Any agent can list itself. One transaction deploys a vault, sets its terms, locks them and registers the agent. Nobody approves it. The terms cover size per order, per market and per block, leverage, drawdown, daily loss, how long a position may be held, which markets and which direction, and how old the mark may be. Fees are capped and paid only in vault shares. | 누구나 에이전트를 등록할 수 있다. 트랜잭션 한 번이 볼트를 만들고, 조건을 설정해 잠그고, 에이전트를 등록한다. 승인하는 사람은 없다. 조건은 주문·시장·블록당 규모, 레버리지, 최대 손실폭, 하루 손실, 포지션 보유 시간, 거래 가능 시장과 방향, 가격 데이터의 나이를 포함한다. 주문 가격 범위와 스트레스 검사는 조건표 화면에 보이므로 말로는 뺐다. 수수료는 상한이 있고 볼트 지분으로만 지급된다. |
| 1:03 | Market으로 돌아가 Tight Mandate 줄을 클릭한다. Agent 화면의 TERM SHEET 표에서 "If crossed" 칸을 위에서부터 짚는다: 거래 조건(주문 거절), Drawdown(동결), Daily loss(일시정지), Unobservable(재개 가능한 동결). | Every vault shows its term sheet: the locked value, where the vault stands now, and what happens when it is crossed. An order past a trade term is simply refused. Drawdown and holding time freeze the agent for good. Daily loss only pauses new risk until the next day. And if the price feed stalls, the agent is frozen, but anyone can resume it once a fresh mark is back inside the limits. | 모든 볼트는 조건표를 보여 준다. 잠긴 값, 지금 상태, 넘었을 때 일어나는 일. 거래 조건을 넘는 주문은 거절된다. 손실폭과 보유 시간은 영구 동결. 하루 손실은 다음 날까지 새 위험만 멈춘다. 가격 피드가 끊기면 동결되지만, 새 가격이 한도 안으로 돌아오면 누구나 재개할 수 있다. |
| 1:12 | "Allocate USDC" → 헤더의 "Connect" → "Demo allocator" → 1,000 → "Review allocation" → "approve() + allocate()". | As an allocator, I deposit one thousand test USDC. It goes into the vault contract, not to the agent. | 투자자로서 테스트 USDC 1,000을 넣는다. 돈은 에이전트가 아니라 볼트 컨트랙트로 간다. |
| 1:24 | Live Risk 화면. "Send order inside mandate". 피드에 새 줄이 뜨면 시각을 눌러 탐색기의 트랜잭션을 2초 보여 주고 돌아온다. 이어서 "Send over-limit order". 피드의 REVERTED 줄과 에러 이름을 가리킨다. | Now I act as the agent. An order inside the terms passes the guard and executes, and each line links to its transaction. An order past the leverage limit is refused before it reaches the venue, with the contract's own error. | 이제 에이전트 역할이다. 조건 안의 주문은 가드를 통과해 체결되고 각 줄은 트랜잭션으로 연결된다. 레버리지 한도를 넘는 주문은 거래소에 닿기 전에 컨트랙트 자신의 에러로 거절된다. |
| 1:44 | "−2% shock". 상태가 OVER LIMIT으로 바뀌면 "poke()". FROZEN과 bounty 줄을 보여 준다. 다시 "Send order inside mandate"를 눌러 AgentNotActive 거절을 보여 준다. | The market drops two percent, and this vault is now past its three percent drawdown. Anyone can prove that. Poke re-marks the vault, freezes the agent and pays the caller a small bounty. The agent's next order is refused. | 시장이 2% 빠져 이 볼트는 3% 손실 한도를 넘었다. 누구나 이것을 증명할 수 있다. poke는 볼트를 다시 평가하고 에이전트를 동결하고 호출자에게 소액 보상을 준다. 에이전트의 다음 주문은 거절된다. |
| 2:03 | "unwind()"를 두 번 누른다. 한 블록에 한 번만 된다. 피드의 "unwind step 1/5", "2/5". Allocate 화면으로 가서 "Withdraw all shares". | A frozen position is closed in public steps, a fifth at a time. The allocator can withdraw throughout, paid from the vault's cash at a fresh mark. In an active vault, a redemption request gives the agent a day to free the cash, and after that anyone can force it. Even if the price feed stops, a cash-only exit stays open. | 동결된 포지션은 한 번에 5분의 1씩 공개적으로 정리되고, 투자자는 그동안 언제든 새 가격 기준으로 볼트의 현금에서 인출할 수 있다. 활성 볼트에서는 출금 요청이 에이전트에게 현금을 마련할 하루를 주고, 그 뒤에는 누구나 포지션 축소를 강제할 수 있다. 가격 데이터가 끊겨도 현금만 받는 비상 출구가 열려 있다. |
| 2:18 | 로컬 빌드에서만. Live Risk 화면, Tight Mandate. "12s marks · 12s-block chain"을 누르고 mark age가 4초를 넘은 뒤 "Send order inside mandate". 피드에 REVERTED MarkTooOld. 이어서 "1s marks · Monad"를 누르고 같은 버튼. 주문이 통과한다. | On the local build this vault asks for a mark under four seconds. At one mark every twelve seconds, the most a twelve-second chain allows, the order reverts a few seconds after each mark. At Monad's cadence the same order passes. A mandate can only demand a price as fresh as the chain's blocks, which is why we build on Monad. | 로컬 빌드에서 이 볼트는 4초 이내 가격을 요구한다. 12초 블록 체인이 낼 수 있는 최대 빈도인 12초 갱신에서는 갱신 몇 초 뒤부터 주문이 되돌려진다. Monad 주기에서는 같은 주문이 통과한다. 조건이 요구할 수 있는 가격의 신선도는 블록 간격만큼이고, 그래서 Monad 위에 만든다. |
| 2:45 | Market 화면으로 돌아와 끝. | Today the venue and the USDC are mocks. An adapter for Perpl, a perpetuals exchange on Monad, is written and tested against a fork of Monad testnet. | 지금 거래소와 USDC는 mock이다. Monad의 무기한선물 거래소 Perpl용 어댑터는 작성했고 Monad 테스트넷 포크에서 테스트했다. |

## 줄일 곳

3분을 넘으면 이 순서로 뺀다.

1. 장면 1:24에서 탐색기로 넘어가는 2초.
2. 장면 2:03의 두 번째 unwind와 마지막 문장 "Even if the price feed stops…". 그다음 출금 대기열 문장.

Batch 화면과 Privacy 화면은 이번 개편에서 뺐다. 프로젝트 설명에 시간을 쓰면 들어갈 자리가 없다. 넣으려면 장면 2:18을 빼야 하는데, 그 장면이 Monad 위에 만드는 이유를 보여 주므로 권하지 않는다.

## 확인해 둘 것

- 장면 0:30에서 공개 주소로 녹화하면 Launch를 제출하지 않는다. 서버 서명 정책이 이 호출을 허용할지 팀이 아직 정하지 않았다. 로컬 빌드에서는 제출해도 된다. 제출하면 Market에 다섯 번째 줄이 생기므로, 장면 순서를 지키려면 나머지 장면을 먼저 찍고 Launch 제출은 따로 찍어 붙인다.
- 장면 1:24의 에러 이름은 LeverageExceeded로 예상한다. 녹화 때 화면에 나온 이름을 그대로 둔다.
- 장면 2:18은 12초 모드를 먼저, 1초 모드를 나중에 한다. 순서를 바꾸면 목표 레버리지에 이미 도달해 주문이 나가지 않을 수 있다("already at the target").
- 12초 모드에서도 가격 갱신 직후 4초가량은 주문이 통과한다. 로컬 실측(10-04): 2.5초 간격 12회 중 5회 통과, 7회 MarkTooOld. 그래서 내레이션은 "갱신 몇 초 뒤부터"라고만 말한다.
- 공개 주소의 Tight Mandate 가격 조건은 10초, 로컬은 4초다. 장면 2:18은 로컬 값만 말한다.
- 장면 2:03의 비상 출구는 말로만 언급한다. 가격 데이터가 끊긴 상태는 데모 버튼으로 만들 수 없다.
- 거래소와 USDC가 mock이고 가격은 팀의 키퍼가 넣는다는 점을 영상 설명란에도 한 줄로 적는다.
- Perpl 어댑터는 테스트넷에 배포하지 않았다. "deployed"나 "live on Perpl"이라고 말하지 않는다.
- 영상에 니모닉, `.env`, `?admin=` 주소가 보이면 안 된다.

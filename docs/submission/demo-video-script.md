# 데모 영상 대본 (제출 폼: Technical demo video)

- 조건: 3분 이하. 동작하는 제품을 보여 줄 것. 슬라이드와 코드 설명은 불가. YouTube, Loom, Vimeo 같은 영상 호스트의 링크로 제출.
- 상태: 초안 (2026-10-04 작성, 10-05 공개 주소와 선택 장면 추가). AI 도구(Claude Code)로 쓴 초안이고 녹화 전이다. 팀이 읽어 보고 고쳐 쓴다.
- 화면 문구는 저장소 `web/index.html`, `web/app.js` 기준이다. 화면이 바뀌면 이 대본도 맞춘다.
- 내레이션은 영어 약 300단어, 말하는 시간 약 2분 15초. 나머지는 트랜잭션이 채굴되는 화면이다.

## 녹화 전 준비

1. 테스트넷을 초기 상태로 만든다. 네 볼트가 모두 Active, 가격 $2000. 최종 재배포 직후가 가장 깨끗하다.
2. 본편(장면 1~8)은 Live product 주소에서 녹화한다. 주소창에 공개 주소가 보여야 심사위원이 같은 화면을 다시 열 수 있다. 공개 주소는 `https://mandate-e4kb.onrender.com` (Render에 호스팅).
3. 페이지를 열고 10초쯤 기다린 뒤 시작한다. 접속자가 없으면 가격 갱신이 느려져 첫 클릭이 MarkTooOld로 거절될 수 있다.
4. 장면 9는 로컬 빌드에서 따로 녹화해 이어 붙인다. 저장소에서 `npm run web` 후 `http://localhost:3000`. 블록 주기 스위치는 로컬 빌드에만 있다.
5. 브라우저 창은 1280×720 이상, 글자가 읽히게 확대 110~125%. 북마크 바와 다른 탭은 숨긴다.
6. 기다리는 구간은 잘라도 된다. 결과 화면을 바꾸거나 합성하지 않는다.

## 장면

| 시간 | 화면에서 하는 일 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 0:00 | Market 화면. 네 줄의 볼트와 한도 대비 수치를 천천히 보여 준다. | This is Mandate, running on Monad testnet. Four agent vaults trade on one venue, each under a different mandate. Every number on this page is read from the contracts. | 모나드 테스트넷에서 도는 Mandate다. 볼트 넷이 한 거래소에서 서로 다른 조건으로 거래한다. 숫자는 전부 컨트랙트에서 읽은 값이다. |
| 0:12 | Tight Mandate 줄을 클릭한다. Agent 화면으로 넘어간다. Risk limits 패널과 TERMS 해시를 가리킨다. | I pick Tight Mandate. Its limits live in contract storage and were locked before the first deposit: three times leverage, three percent drawdown, and a price mark no older than ten seconds. This hash is the fingerprint of those terms. | Tight Mandate를 고른다. 한도는 컨트랙트에 저장돼 있고 첫 예치 전에 잠겼다. 레버리지 3배, 손실 한도 3%, 가격 기준 시각은 10초 이내. 이 해시가 조건의 지문이다. |
| 0:32 | "Allocate USDC" → 헤더의 "Connect allocator" → 1,000 → "Review allocation" → "approve() + allocate()". | I connect as the allocator and deposit one thousand test USDC. The money goes into the vault contract. The agent's key can trade it and cannot withdraw it. | 투자자로 접속해 테스트 USDC 1,000을 넣는다. 돈은 볼트 컨트랙트로 들어간다. 에이전트 키는 거래만 하고 인출은 못 한다. |
| 0:52 | Live Risk 화면. "Send order inside mandate". Execution feed에 새 줄이 뜨면 시각을 클릭해 monadscan의 트랜잭션을 2~3초 보여 주고 돌아온다. | Now I act as the agent. An order inside the mandate passes the risk guard and executes. Each line in this feed links to its transaction on the Monad explorer. | 이제 에이전트 역할이다. 조건 안의 주문은 가드를 통과해 체결된다. 피드의 각 줄은 모나드 탐색기의 트랜잭션으로 연결된다. |
| 1:12 | "Send over-limit order". 피드의 REVERTED 줄과 에러 이름을 가리킨다. | An order past the leverage limit is refused before it reaches the venue. The feed shows the contract's own error. | 레버리지 한도를 넘는 주문은 거래소에 닿기 전에 거절된다. 피드에 컨트랙트가 낸 에러가 그대로 나온다. |
| 1:26 | "−2% shock". 몇 초 뒤 상태가 OVER LIMIT으로 바뀌는 것을 보여 준다. | The market drops two percent. This vault runs at about two times leverage, so it is now about four percent under its high-water mark, past its three percent limit. | 시장이 2% 빠진다. 이 볼트는 약 2배 레버리지라 고점 대비 약 4% 아래, 3% 한도를 넘었다. |
| 1:42 | "poke()" 버튼. 상태가 FROZEN으로 바뀌고 피드에 bounty 줄이 뜬다. 이어서 "Send order inside mandate"를 눌러 AgentNotActive 거절을 보여 준다. | Anyone can prove that. I call poke: the guard re-marks the vault, freezes the agent and pays the caller a small bounty. The agent's next order is refused. | 누구나 이걸 증명할 수 있다. poke를 부르면 가드가 다시 평가하고 에이전트를 동결하고 호출자에게 소액 보상을 준다. 에이전트의 다음 주문은 거절된다. |
| 2:00 | "unwind()"을 두 번 누른다(한 블록에 한 번만 가능). 피드의 "unwind step 1/5", "2/5". Allocate 화면으로 가서 "Withdraw all shares". | A frozen position is closed in public steps, one fifth per call. The allocator can withdraw at any point, at a fresh price. | 동결된 포지션은 한 번에 5분의 1씩 공개적으로 정리된다. 투자자는 그동안 언제든 새 가격 기준으로 인출할 수 있다. |
| 2:18 | (로컬 빌드로 전환) Live Risk 화면, Tight Mandate 선택 상태. 먼저 "12s marks · 12s-block chain"을 누른다. 화면의 mark age가 4초를 넘은 것을 확인하고 "Send order inside mandate"를 누른다. 피드에 REVERTED MarkTooOld. 스위치 아래 설명 문장을 보여 준다. 이어서 "1s marks · Monad"를 누르고 같은 버튼을 누른다. 주문이 통과한다. | One more thing, on the local build. Here this vault asks for a mark no older than four seconds. I slow the oracle to one mark every twelve seconds, the most a twelve-second chain allows. A few seconds after a mark, the order reverts with MarkTooOld. Back at one-second cadence, the same order passes. A mandate can only ask for a mark as fresh as the chain's block interval allows. That is why Mandate is built on Monad. | 로컬 빌드에서 하나 더. 여기서는 이 볼트가 4초 이내의 가격을 요구한다. 가격 갱신을 12초에 한 번으로 늦춘다. 12초 블록 체인이 낼 수 있는 최대 빈도다. 갱신 몇 초 뒤부터 주문은 MarkTooOld로 되돌려진다. 1초 주기로 돌아오면 같은 주문이 통과한다. 조건이 요구할 수 있는 가격의 신선도는 블록 간격이 허락하는 만큼이다. 그래서 Monad 위에 만든다. |
| 2:50 | Market 화면으로 돌아와 끝. | (없음) | |

## 선택 장면: Batch와 Privacy (10-05 추가)

10-04에 Batch 화면과 Privacy 화면이 생겼다. 본편이 이미 2분 50초라 둘을 다 넣으면 3분을 넘는다. 넣으려면 장면 4의 monadscan 확인과 장면 8의 두 번째 unwind를 줄여 20초쯤 확보한다. 넣을지는 팀이 정한다.

공개 주소에 두 화면이 올라와 있다(10-05 제출 현황판 기준). 녹화는 공개 주소에서 한다.

| 길이 | 화면에서 하는 일 | 내레이션 (영어) | 뜻 |
| --- | --- | --- | --- |
| 약 12초 | Privacy 화면. "postLeaderboard()"를 누른다. 배지가 VERIFIED ONCHAIN으로 바뀌고 Cumulative ε가 늘어나는 것을 보여 준다. | Vault statistics are published with noise, and the registry contract keeps the privacy budget. The page re-reads the release from the contract before it says verified. | 볼트 통계는 노이즈를 넣어 게시하고, 레지스트리 컨트랙트가 프라이버시 예산을 기록한다. 화면은 컨트랙트에서 다시 읽은 뒤에 검증됨을 표시한다. |
| 약 15초 | Batch 화면. "depositEscrow()" → "Sign AllocationIntent" → 20초 epoch가 끝난 뒤 "settleEpoch()" → "claimShares()". 기다리는 구간은 자른다. | Allocators can also sign an intent instead of depositing directly. One settlement nets an epoch into a single deposit per vault, and each allocator claims shares with a Merkle proof. | 투자자는 직접 예치하는 대신 의향에 서명할 수도 있다. 한 번의 정산이 한 epoch를 볼트당 한 건의 예치로 묶고, 각자 Merkle 증명으로 지분을 받는다. |

- Privacy 화면의 통계는 공개된 볼트 가격에서 계산한다. "private data is protected"처럼 말하지 않는다.
- 테스트넷에서는 release를 2분에 한 번만 낼 수 있고 ε 한도는 100회 분량이다. 녹화 직전에 여러 번 누르지 않는다.

## 확인해 둘 것

- 장면 5의 에러 이름은 한도보다 0.8배 높은 레버리지를 노리는 주문이라 LeverageExceeded가 나올 것으로 본다. 녹화 때 화면에 나온 이름을 그대로 둔다.
- 장면 9는 12초 모드를 먼저, 1초 모드를 나중에 한다. 같은 버튼을 통과 뒤에 다시 누르면 목표 레버리지에 이미 도달해 주문이 나가지 않을 수 있다("already at the target").
- 12초 모드에서도 가격 갱신 직후 4초가량은 주문이 통과한다. 로컬 실측(10-04): 2.5초 간격 12회 중 5회 통과, 7회 MarkTooOld. 통과했으면 몇 초 뒤 다시 누른다. 그래서 내레이션은 "갱신 몇 초 뒤부터 되돌려진다"라고만 말한다. "전부 막힌다"고 말하지 않는다.
- 테스트넷 본편에서 Tight Mandate의 가격 조건은 10초다. 4초는 로컬 빌드의 값이다. 내레이션이 이 차이를 그대로 말한다.
- 거래소와 USDC는 mock이고 가격은 팀의 키퍼가 넣는다. 영상 설명란이나 자막 한 줄로 적는다.
- 영상에 니모닉, `.env`, `?admin=` 주소가 보이면 안 된다.

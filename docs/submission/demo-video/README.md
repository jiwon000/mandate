# 데모 영상 녹화 스크립트

2026-10-06에 데모 영상 4종(한국어·영어 자막, 각각 내레이션 있음·없음)을 만든 스크립트입니다. 영상 파일은 크기 때문에 저장소에 넣지 않고 GitHub 드래프트 릴리스 `demo-video-2026-10-06`에 올렸습니다. 드래프트는 저장소에 쓰기 권한이 있는 팀원에게만 보입니다.

**이번 영상은 제출용으로 쓸 수 없습니다.** 로컬 노드(체인 31337)에서 녹화해서 화면에 Monad 테스트넷 상호작용이 없습니다. 제출 요건은 "실제 동작과 Monad 상호작용 장면"입니다. 테스트넷 재배포 뒤 아래 체크리스트대로 다시 찍습니다.

## 파일

- `record.mjs`: playwright-core와 Chrome으로 1280x720 헤드리스 녹화. 커서, 클릭 표시, 한 줄 자막, 동작 배지를 페이지에 넣는다. 장면 9개.
- `scenes.json`, `scenes.ko.json`: 장면별 내레이션 원문 (영어, 한국어). 대본은 [`../demo-video-script.md`](../demo-video-script.md).
- `chunks.en.json`, `chunks.ko.json`: 한 줄 자막 조각과 시작 시각(`at`, 초).

## 순서

필요: `npm i playwright-core`, Google Chrome, ffmpeg, macOS `say`.

1. TTS. 문장마다 따로 만들고 0.25초 무음으로 이어 장면별 `audio-xx/s{i}.aiff`를 만든다.
   - 한국어 `say -v Yuna -r 200`. 읽기 치환: Mandate→맨데이트, USDC→유에스디씨, poke→포크, Perpl→퍼플, Monad→모나드, mock→모의 구현
   - 영어 `say -v Samantha -r 168`
2. 녹화. 장면 길이는 오디오 길이 + 0.8초.
   ```bash
   BASE=http://localhost:3222/ CAPS=scenes.ko.json CHUNKS=chunks.ko.json AUD=audio-ko SEGS=segs.ko.json node record.mjs
   ```
3. 합성. `segs.*.json`의 구간대로 장면별로 자르고, 오디오를 `adelay=300|300,apad`와 `-shortest`로 붙인 뒤 concat(copy). 무음판은 오디오 없이 같은 컷.
   자막은 ffmpeg가 아니라 브라우저에서 구워 넣는다.

로컬 녹화 서버는 비밀값 없이 띄운다.

```bash
env -u DEMO_MNEMONIC -u MONAD_RPC_URL -u DEMO_ADMIN_TOKEN -u MANDATE_LIVE PORT=3222 node web/server.mjs
```

## 재녹화 체크리스트 (테스트넷 재배포 뒤)

### 녹화 전

- [ ] 재배포는 팀이 결정하고 실행했다. 배포 커밋과 URL을 확인했다.
- [ ] `BASE`를 배포 URL로 넘긴다.
- [ ] 화면 상단에 `Monad testnet`, 체인 10143이 보인다 (`Local RPC · chain 31337`이 아님).
- [ ] 데모 지갑 잔고(MON 가스, mock USDC)가 장면 전체를 돌릴 만큼 있다. 비밀값은 사람이 호스트 env에 넣었고 스크립트에는 없다.
- [ ] 장면 6 뒤의 `#redeployButton` 리셋이 공개 배포에서 어떻게 동작하는지 확인했다. 안 되면 장면 7을 새 볼트로 시작하게 바꾼다.
- [ ] 테스트넷 확정 대기 시간 안에 각 장면의 대기 조건이 풀리는지 한 번 리허설했다.

### 넣어야 할 장면

- [ ] 상단 네트워크 표시(Monad testnet, 10143)가 2초 이상 보인다.
- [ ] 입금·주문·poke·청산 중 하나의 이벤트 피드 시각을 클릭해 `testnet.monadscan.com/tx/...`에서 성공한 거래를 2~3초 보여 준다. 테스트넷에서는 `web/app.js`가 링크를 붙인다.
- [ ] Launch로 만든 볼트 주소를 탐색기에서 한 번 연다.
- [ ] 12초 마크 대 1초 마크 장면은 "갱신 주기를 바꿔 보여 준다"로 말한다. 데모의 마크 갱신 주기는 데모 서버가 정하므로 실측이라고 하지 않는다.

### 내레이션과 자막

- [ ] `scenes*.json`, `chunks*.json`의 "로컬", "local" 표현을 테스트넷 기준으로 고쳤다.
- [ ] 거래소와 USDC가 mock이라는 점은 그대로 밝힌다.
- [ ] Monad를 쓰는 이유는 마크 유효시간 논리 하나만 말한다.
- [ ] 제출용은 영어판, 학회용은 한국어판.

### 녹화 후

- [ ] 길이 3분 이하: `ffprobe -v error -show_entries format=duration -of csv=p=0 <파일>`
- [ ] 화면에 토큰, 니모닉 같은 비밀값이 보이지 않는다.
- [ ] 탐색기 장면에서 거래 상태가 Success로 읽힌다.
- [ ] 공개 링크(YouTube, Loom, Vimeo) 업로드와 폼 입력은 팀이 한다.

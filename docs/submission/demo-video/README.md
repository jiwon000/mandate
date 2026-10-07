# 데모 영상 녹화 스크립트

2026-10-06에 공개 데모(<https://mandate-e4kb.onrender.com>, Monad 테스트넷 10143)에서 녹화한 데모 영상 4종(한국어·영어, 각각 내레이션 있음·없음, 2분 45초)을 만든 스크립트입니다. 영상 파일은 크기 때문에 저장소에 넣지 않고 GitHub 드래프트 릴리스 `demo-video-2026-10-06`에 올립니다. 드래프트는 저장소에 쓰기 권한이 있는 팀원에게만 보입니다.

화면에 나오는 것: 상단 `Monad testnet` 표시, 브라우저 지갑으로 Launch(새 볼트 배포), 배분, 한도 초과 주문 거절(`PositionNotionalExceeded`), poke 동결과 청산, 인출, 탐색기(`testnet.monadscan.com`)에서 거래 Success와 새 볼트 컨트랙트 페이지. 거래소와 USDC는 mock이라고 내레이션에서 밝힙니다.

## 파일

- `record.mjs`: playwright-core와 Chrome으로 1280x720 녹화. 커서, 클릭 표시, 한 줄 자막, 동작 배지를 페이지에 넣는다. 장면 9개. Launch는 페이지에 넣은 최소 EIP-1193 지갑이 Node에서 서명한다.
- `tts.mjs`: 장면별 내레이션 오디오 생성 (macOS `say`).
- `mux.mjs`: `segs*.json` 구간대로 자르고 오디오를 붙여 최종 mp4를 만든다.
- `segs.final.json`: 실제 영상에 쓴 편집 구간. 장면마다 원본 녹화 파일(`video`), 이어 붙일 조각(`parts`), 배속(`speed`)을 가질 수 있다.
- `scenes.json`, `scenes.ko.json`: 장면별 내레이션 원문 (영어, 한국어). 대본은 [`../demo-video-script.md`](../demo-video-script.md).
- `chunks.en.json`, `chunks.ko.json`: 한 줄 자막 조각과 시작 시각(`at`, 초).

## 순서

필요: `npm i playwright-core ethers`, Google Chrome, ffmpeg, macOS `say`.

1. TTS: `node tts.mjs ko`, `node tts.mjs en`. 자막 조각 `chunks.<lang>.json`도 함께 만든다. 문장마다 따로 만들고 0.25초 무음으로 이어 `audio-xx/s{i}.aiff`.
   - 한국어 `say -v Yuna -r 200`. 읽기 치환: Mandate→맨데이트, USDC→유에스디씨, poke→포크, Perpl→퍼플, Monad→모나드, mock→모의 구현
   - 영어 `say -v Samantha -r 168`
2. 녹화. 장면 길이는 오디오 길이 + 0.8초.
   ```bash
   KEY_FILE=<저장소 밖 녹화 지갑 파일> CAPS=scenes.ko.json CHUNKS=chunks.ko.json AUD=audio-ko SEGS=segs.json node record.mjs
   ```
   - `KEY_FILE`의 지갑은 Launch 가스만 낸다 (테스트넷 MON 몇 개면 충분). 저장소에 넣지 않는다.
   - 실패한 장면만 다시 찍을 때: `ONLY=1,7 SEGS=segs.patch.json node record.mjs`. 나머지 장면은 건너뛴다.
   - 로컬 노드에서 연습할 때: `BASE=http://localhost:3222/ RPC=http://127.0.0.1:8545 CHAIN_ID=31337 LABEL=31337`.
3. 합성: `node mux.mjs ko segs.final.json` (영어는 `en`). 무음판은 오디오 없이 같은 컷. 자막은 ffmpeg가 아니라 브라우저에서 구워 넣는다.
   - 자막은 장면의 첫 줄이 0.2초에 걸쳐 나타나고 마지막 줄이 0.2초에 걸쳐 사라진다. 클릭 표시(테두리, 동작 배지, 물결)도 서서히 켜지고 꺼진다. 클릭 표시는 녹화 화면에 찍히므로 재녹화해야 바뀌고, 자막은 기존 녹화로 다시 합성만 하면 된다.
   - Chrome 대신 다른 Chromium 브라우저를 쓰려면 `CHROME=<실행 파일 경로>`.
   - `KEY_FILE`은 `[{private_key}]` 목록이나 `{privateKey}` 객체 둘 다 읽는다. Launch 영수증에서 새 볼트를 찾을 팩토리 주소는 `BASE`의 `/api/deployment`에서 읽는다.

## 녹화에서 배운 것

- monadscan은 헤드리스 브라우저에 Cloudflare 확인 화면을 띄운다. 탐색기 장면이 있으면 창을 띄운(headful) Chrome으로 녹화한다. 확인 화면을 우회하지 않는다.
- Tight Mandate의 `maxMarkAgeSeconds`는 10초라, 마크가 오래되면 배분·청산·인출이 `0xf98e85fe`(mark too old)로 되돌려진다. 스크립트는 거래 직전에 새 마크를 기다린다(`freshMark`).
- 테스트넷 RPC가 가끔 네트워크 감지에 실패한다. provider에 고정 `Network`를 주고 전송을 재시도한다.
- 한 번에 다 찍을 필요가 없다. 실패한 장면만 `ONLY`로 다시 찍어 `segs.final.json`에서 이어 붙인다.
- 3분을 넘기면 기다리는 장면(배분 확정 등)을 `speed`로 1.2~1.6배 빠르게 한다.

## 재녹화 체크리스트

### 녹화 전

- [ ] 화면 상단에 `Monad testnet`, 체인 10143이 보인다.
- [ ] 녹화 지갑에 Launch 가스가 있다. 데모 계정 비밀값은 사람이 호스트 env에 넣었고 스크립트에는 없다.
- [ ] `#redeployButton`(관리자 리셋)은 누르지 않는다. Tight Mandate 동결 뒤 새 장부는 서버의 `AUTO_RESET_MIN_FROZEN`이 처리한다.

### 녹화 후

- [ ] 길이 3분 이하: `ffprobe -v error -show_entries format=duration -of csv=p=0 <파일>`
- [ ] 화면에 토큰, 니모닉, 키 같은 비밀값이 보이지 않는다.
- [ ] 탐색기 장면에서 거래 상태가 Success로 읽힌다.
- [ ] 내레이션에 Monad를 쓰는 이유는 마크 유효시간 논리 하나만 말한다.
- [ ] 공개 링크(YouTube, Loom, Vimeo) 업로드와 폼 입력은 팀이 한다.

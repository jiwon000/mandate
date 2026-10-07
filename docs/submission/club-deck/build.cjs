const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.title = "Mandate 학회 발표";
const C = { bg:"0A0C0F", panel:"13161A", panel2:"1A1B26", line:"1F2429", text:"F2F2EF", muted:"A8AFB7", dim:"6E757D", acc:"8B7BFE", green:"3DDC97", red:"FF6B7A", amber:"FFC35C" };
const F = "Pretendard", M = "Menlo";
const W = 13.333, X0 = 0.7;
let n = 0; const TOTAL = 14;
function base(eyebrow, title) {
  const s = pres.addSlide(); n++;
  s.background = { color: C.bg };
  if (eyebrow) s.addText(eyebrow, { x:X0, y:0.45, w:9, h:0.3, fontFace:F, fontSize:11, color:C.acc, charSpacing:1, margin:0, isTextBox:true });
  if (title) s.addText(title, { x:X0, y:0.78, w:W-1.4, h:0.8, fontFace:F, bold:true, fontSize:32, color:C.text, margin:0, isTextBox:true });
  s.addText("MANDATE", { x:X0, y:7.0, w:3, h:0.25, fontFace:M, fontSize:9, color:C.dim, charSpacing:3, margin:0, isTextBox:true });
  s.addText(`${String(n).padStart(2,"0")} / ${TOTAL}`, { x:W-X0-2, y:7.0, w:2, h:0.25, fontFace:M, fontSize:9, color:C.dim, align:"right", margin:0, isTextBox:true });
  return s;
}
const card = (s, x, y, w, h, fill = C.panel, line = C.line) =>
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius:0.08, fill:{ color:fill }, line:{ color:line, width:0.75 } });
const txt = (s, t, o) => s.addText(t, { fontFace:F, color:C.text, margin:0, isTextBox:true, valign:"top", ...o });
const chip = (s, t, x, y, color = C.acc) => {
  const w = 0.12 + t.length * 0.085;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h:0.3, rectRadius:0.06, fill:{ color:C.panel2 }, line:{ color, width:0.75 } });
  s.addText(t, { x, y, w, h:0.3, fontFace:M, fontSize:10, color, align:"center", valign:"middle", margin:0, isTextBox:true });
  return w;
};

// 1 Title
{
  const s = pres.addSlide(); n++;
  s.background = { color: C.bg };
  txt(s, "HYBLOCK · 모나드 메트로폴리스 · 트랙 1 — 온체인 금융과 트레이딩", { x:X0, y:1.3, w:11, h:0.35, fontSize:13, color:C.acc, charSpacing:1 });
  txt(s, "Mandate", { x:X0, y:1.85, w:10, h:1.4, bold:true, fontSize:80 });
  txt(s, "트레이더가 아니라 조건을 보고 돈을 맡기는 시장", { x:X0, y:3.35, w:11, h:0.6, bold:true, fontSize:28, color:C.text });
  txt(s, "에이전트는 맡긴 돈으로 거래만 할 수 있고, 꺼내 갈 수는 없습니다.\n지키기로 한 조건은 운영자의 약속이 아니라 컨트랙트가 지킵니다.", { x:X0, y:4.15, w:10, h:0.9, fontSize:17, color:C.muted, paraSpaceAfter:4 });
  let x = X0;
  for (const t of ["maxLeverageX100", "maxDrawdownBps", "maxMarkAgeSeconds", "allowedMarkets", "performanceFeeBps"]) x += chip(s, t, x, 5.45) + 0.15;
  txt(s, "2026년 10월 학회 발표  ·  github.com/jiwon000/mandate", { x:X0, y:6.85, w:10, h:0.3, fontFace:M, fontSize:11, color:C.dim });
}

// 2 Team
{
  const s = base("팀 구성", "팀원별 담당 파트");
  const cols = [
    ["@jiwon000", ["MandateRegistry: 에이전트 카탈로그와 조건 대조", "DP Reporter: 차등 프라이버시 성과 공개", "Batch 정산과 Privacy 화면 연동", "Foundry invariant·퍼징 테스트", "보안 리뷰 4회: registerAgent 수정, 마켓 기능 점검"]],
    ["@yahamang", ["MandateVault, MandateRiskGuard: 수탁, 한도 검사, 동결과 청산", "MandateFactory와 Launch 화면: 누구나 등록", "거래 조건 6종과 수수료 징수", "Perpl 거래소 어댑터와 포크 테스트", "테스트넷 데모 서버, 제출 문서, 데모 영상"]],
  ];
  cols.forEach(([who, items], i) => {
    const x = X0 + i * 6.1, y = 1.95;
    card(s, x, y, 5.8, 4.6);
    txt(s, who, { x:x+0.4, y:y+0.35, w:5, h:0.45, fontFace:M, fontSize:18, bold:true, color:C.acc });
    txt(s, items.map((t, k) => ({ text:t, options:{ bullet:{ indent:14 }, breakLine:k < items.length-1 } })), { x:x+0.4, y:y+1.05, w:5.1, h:3.3, fontSize:16, color:C.text, paraSpaceAfter:12 });
  });
}

// 3 Problem
{
  const s = base("신뢰의 문제", "AI 에이전트에게 돈을 맡기면 생기는 일");
  card(s, X0, 1.85, W-1.4, 1.05, C.panel2, C.panel2);
  txt(s, [
    { text:"상황  ", options:{ bold:true, color:C.acc } },
    { text:"A가 트레이딩 에이전트에게 10,000 USDC를 맡깁니다. 약속한 조건은 “레버리지 최대 3배, 고점 대비 손실 3%를 넘으면 중단”." },
  ], { x:X0+0.35, y:2.1, w:W-2.1, h:0.6, fontSize:17, valign:"middle" });
  const P = [
    ["거래하는 키가 곧 꺼내는 키", "보통 에이전트가 쓰는 지갑에 돈이 들어갑니다. 키가 털리거나 운영자가 마음을 바꾸면 돈이 나갑니다."],
    ["한도는 약속일 뿐", "“3%에서 멈춘다”는 운영자의 말입니다. 레버리지를 10배로 올려도 막을 장치가 없습니다."],
    ["운영자가 사라지면 끝", "손실 중인 포지션을 닫아 줄 사람이 없습니다. A는 기다리는 것밖에 할 수 없습니다."],
  ];
  P.forEach(([h, b], i) => {
    const w = (W - 1.4 - 0.5) / 3, x = X0 + i * (w + 0.25), y = 3.2;
    card(s, x, y, w, 3.2);
    s.addShape(pres.shapes.OVAL, { x:x+0.35, y:y+0.4, w:0.18, h:0.18, fill:{ color:C.red }, line:{ color:C.red } });
    txt(s, h, { x:x+0.35, y:y+0.75, w:w-0.7, h:0.5, bold:true, fontSize:20 });
    txt(s, b, { x:x+0.35, y:y+1.4, w:w-0.7, h:1.6, fontSize:15, color:C.muted, lineSpacingMultiple:1.25 });
  });
}

// 4 Idea
{
  const s = base("접근 방식", "질문을 바꿉니다");
  txt(s, "“이 트레이더를 믿을 수 있나?”", { x:X0, y:1.95, w:5.6, h:0.6, fontSize:24, color:C.dim, strike:"sngStrike" });
  txt(s, "“이 조건을 받아들일 수 있나?”", { x:X0, y:2.6, w:7, h:0.7, bold:true, fontSize:32, color:C.text });
  txt(s, "조건은 첫 입금 전에 체인에 잠기고, 잠긴 뒤에는 운영자도 바꿀 수 없습니다. 배분자는 성과 주장 대신 잠긴 조건을 읽고 결정합니다.", { x:X0, y:3.45, w:7.2, h:0.9, fontSize:16, color:C.muted, lineSpacingMultiple:1.25 });
  const R = [
    ["에이전트 운영자", "조건을 걸고 스스로 등록합니다. 맡은 돈으로 주문만 낼 수 있습니다.", C.acc],
    ["배분자", "조건을 읽고 입금합니다. 출금 권한은 배분자에게만 있습니다.", C.green],
    ["누구나", "조건 위반을 증명해 동결시키고, 청산을 실행하고 보상을 받습니다.", C.amber],
  ];
  R.forEach(([h, b, col], i) => {
    const x = 8.4, y = 1.95 + i * 1.55;
    card(s, x, y, 4.23, 1.35);
    s.addShape(pres.shapes.OVAL, { x:x+0.3, y:y+0.3, w:0.16, h:0.16, fill:{ color:col }, line:{ color:col } });
    txt(s, h, { x:x+0.6, y:y+0.2, w:3.4, h:0.4, bold:true, fontSize:17, color:col });
    txt(s, b, { x:x+0.3, y:y+0.62, w:3.7, h:0.65, fontSize:13, color:C.muted, lineSpacingMultiple:1.15 });
  });
  card(s, X0, 4.75, 7.2, 1.6, C.panel2, C.panel2);
  txt(s, [
    { text:"플랫폼이 정하는 것", options:{ bold:true, color:C.acc, breakLine:true } },
    { text:"조건의 종류와 허용 범위 (예: 손실 한도 최대 50%, 마크 유효시간 최대 60초, 성과 수수료 최대 30%)", options:{ breakLine:true } },
    { text:"운영자가 정하는 것", options:{ bold:true, color:C.acc, breakLine:true } },
    { text:"그 범위 안의 실제 값" },
  ], { x:X0+0.35, y:4.95, w:6.6, h:1.3, fontSize:14, color:C.text, paraSpaceAfter:3 });
}

// 5 Flow
{
  const s = base("동작 방식", "한 번의 사이클: 등록부터 출금까지");
  const steps = [
    ["등록", "createMandate()", "트랜잭션 하나로 볼트 배포, 조건 잠금, 레지스트리 등록. 승인 절차 없음."],
    ["입금", "allocate()", "돈은 에이전트가 아니라 볼트 컨트랙트로. 배분자는 지분을 받음."],
    ["주문", "execute()", "모든 주문이 RiskGuard를 먼저 통과해야 거래소에 닿음. 넘으면 트랜잭션째 취소."],
    ["동결", "poke()", "고점 대비 손실이나 보유 시간이 한도를 넘으면 누구나 증명해 동결. 호출자 보상 0.05%."],
    ["청산", "unwind()", "누구나 다섯 번에 걸쳐 20%씩 포지션을 닫음. 호출당 보상 0.01%."],
    ["출금", "withdraw()", "배분자는 언제든 지분만큼 출금. 운영자 허락 필요 없음."],
  ];
  const w = (W - 1.4 - 5 * 0.18) / 6;
  steps.forEach(([h, fn, b], i) => {
    const x = X0 + i * (w + 0.18), y = 2.0;
    card(s, x, y, w, 4.3, i >= 3 ? C.panel2 : C.panel);
    txt(s, String(i + 1), { x:x+0.25, y:y+0.25, w:0.6, h:0.5, fontFace:M, bold:true, fontSize:22, color:i >= 3 ? C.amber : C.acc });
    txt(s, h, { x:x+0.25, y:y+0.85, w:w-0.4, h:0.45, bold:true, fontSize:21 });
    txt(s, fn, { x:x+0.25, y:y+1.4, w:w-0.3, h:0.3, fontFace:M, fontSize:10.5, color:i >= 3 ? C.amber : C.acc });
    txt(s, b, { x:x+0.25, y:y+1.9, w:w-0.45, h:2.2, fontSize:13, color:C.muted, lineSpacingMultiple:1.2 });
  });
  txt(s, "1~3은 정상 흐름, 4~5는 위반 뒤 흐름입니다. 6은 어느 상태에서나 열려 있습니다.", { x:X0, y:6.5, w:11, h:0.3, fontSize:13, color:C.dim });
}

// 6 Architecture
{
  const s = base("아키텍처", "핵심 아키텍처");
  const box = (x, y, w, h, title, sub, col = C.line, fill = C.panel) => {
    card(s, x, y, w, h, fill, col);
    txt(s, title, { x:x+0.2, y:y+0.15, w:w-0.4, h:0.35, fontFace:M, bold:true, fontSize:13, color:C.text });
    txt(s, sub, { x:x+0.2, y:y+0.52, w:w-0.4, h:h-0.6, fontSize:11.5, color:C.muted, lineSpacingMultiple:1.15 });
  };
  const arrow = (x1, y1, x2, y2, label, col = C.dim) => {
    s.addShape(pres.shapes.LINE, { x:Math.min(x1,x2), y:Math.min(y1,y2), w:Math.abs(x2-x1) || 0.001, h:Math.abs(y2-y1) || 0.001, flipH:x2 < x1, flipV:y2 < y1, line:{ color:col, width:1.5, endArrowType:"triangle" } });
    void label;
  };
  // actors
  box(X0, 2.0, 2.2, 1.05, "배분자", "입금과 출금", C.green);
  box(X0, 4.45, 2.2, 1.05, "에이전트", "주문 권한만", C.acc);
  // vault, guard, adapter, venue
  box(3.75, 2.0, 2.6, 3.5, "MandateVault", "돈을 보관하고 지분을 계산. 마크 가격으로 자산을 평가. 동결·청산·현금 출구·출금 대기열.", C.line);
  box(7.0, 2.0, 2.6, 1.55, "MandateRiskGuard", "잠긴 조건으로 주문 전·후를 검사. 가격 괴리와 노출 상한도 확인", C.acc, C.panel2);
  box(7.0, 3.95, 2.6, 1.55, "VenueAdapter", "Mock 거래소 / Perpl 어댑터", C.line);
  box(10.25, 3.95, 2.38, 1.55, "거래소", "데모: mock\nPerpl: 테스트넷 배포", C.line);
  arrow(2.9, 2.5, 3.75, 2.5, "allocate");
  arrow(2.9, 4.95, 3.75, 4.95, "execute");
  arrow(6.35, 2.75, 7.0, 2.75, "검사");
  arrow(6.35, 4.7, 7.0, 4.7, "주문");
  arrow(9.6, 4.7, 10.25, 4.7, "");
  // factory / registry row
  box(X0, 5.85, 3.6, 0.95, "MandateFactory", "볼트 배포 + 조건 잠금 + 등록을 한 번에", C.amber);
  box(4.55, 5.85, 3.3, 0.95, "MandateRegistry", "조건 해시가 실제 볼트와 같아야 등록", C.line);
  box(8.1, 5.85, 4.53, 0.95, "BatchAllocator · DP Reporter", "에폭 순정산 · 차등 프라이버시 성과 공개", C.line);
  txt(s, "에이전트 키에는 출금 경로가 없습니다. 거래소 어댑터는 같은 주문 형식을 쓰므로, 에이전트 코드를 바꾸지 않고 mock에서 Perpl로 옮길 수 있습니다.", { x:X0, y:1.55, w:11.8, h:0.35, fontSize:13, color:C.muted });
}

// 7 Terms
{
  const s = base("계약 조건", "컨트랙트가 강제하는 조건");
  const groups = [
    ["위험 한도", "RiskLimits · 11개 필드", C.acc, ["레버리지", "고점 대비 손실 (드로다운)", "주문 사이 최소 블록 수", "마크 가격 최대 유효시간", "주문·포지션·전체·블록당 규모", "변동성 스트레스 테스트 (필드 3개)"]],
    ["거래 조건", "TradeTerms · 6개", C.green, ["거래 가능한 마켓", "롱·숏 방향", "마크 대비 주문 가격 허용 폭", "하루 거래 횟수", "하루 손실 한도", "포지션 최대 보유 시간"]],
    ["수수료", "FeeTerms · 2개", C.amber, ["성과 수수료 (상한 30%)", "운용 수수료 (상한 연 5%)", "", "현금이 아니라 볼트 지분으로만 지급", "최고 NAV를 넘은 이익에만 성과 수수료"]],
  ];
  const w = (W - 1.4 - 0.5) / 3;
  groups.forEach(([h, sub, col, items], i) => {
    const x = X0 + i * (w + 0.25), y = 1.85;
    card(s, x, y, w, 3.95);
    txt(s, h, { x:x+0.35, y:y+0.3, w:w-0.7, h:0.45, bold:true, fontSize:21, color:col });
    txt(s, sub, { x:x+0.35, y:y+0.78, w:w-0.7, h:0.3, fontFace:M, fontSize:10.5, color:C.dim });
    const its = items.filter(Boolean);
    txt(s, its.map((t, k) => ({ text:t, options:{ bullet:{ indent:12 }, breakLine:k < its.length-1 } })), { x:x+0.35, y:y+1.25, w:w-0.6, h:2.6, fontSize:14, color:C.text, paraSpaceAfter:7 });
  });
  card(s, X0, 6.0, W-1.4, 0.75, C.panel2, C.panel2);
  txt(s, [
    { text:"원칙  ", options:{ bold:true, color:C.acc } },
    { text:"주문 전에 막을 수 있는 위반은 그 주문만 취소합니다. 가격이 움직여서 저절로 넘는 위반은 세 단계입니다. 하루 손실은 그날만 일시정지, 가격이 끊기면 정지(재개 가능), 고점 대비 손실·보유 시간 초과는 되돌릴 수 없는 동결." },
  ], { x:X0+0.35, y:6.0, w:W-2.1, h:0.75, fontSize:14, valign:"middle" });
}

// 8 After breach
{
  const s = base("위반 이후", "한도를 넘은 뒤에 일어나는 일");
  const K = [
    ["멈춤 3단계", C.red, "poke()", "하루 손실: 다음 UTC 날까지 새 위험만 일시정지. 가격 끊김: 정지, 운영자·키퍼가 resume()으로 재개. 고점 대비 손실·보유 시간 초과: 동결, 되돌릴 수 없음.", "가격이 유효시간의 3배 넘게 끊기면 정지. 청산은 15분 뒤부터"],
    ["청산", C.amber, "unwind()", "누구나 다섯 번에 걸쳐 포지션을 20%씩 닫습니다. 포지션을 줄이는 방향으로만 거래하고, 마크에서 1% 넘게 불리한 가격은 받지 않습니다.", "운영자가 사라져도 남이 끝까지 닫아 줄 보상 구조"],
    ["출금", C.green, "withdraw()", "출금은 동결 중에도 열려 있습니다. 현금이 모자라면 requestRedeem()으로 요청하고, 1일 뒤 누구나 포지션을 줄여 현금을 마련합니다.", "취소는 cancelRedeem(). 피드가 멈추면 withdrawUnpriced()로 현금 몫 출금"],
  ];
  const w = (W - 1.4 - 0.5) / 3;
  K.forEach(([h, col, fn, b, foot], i) => {
    const x = X0 + i * (w + 0.25), y = 1.85;
    card(s, x, y, w, 3.8);
    txt(s, h, { x:x+0.35, y:y+0.3, w:2, h:0.5, bold:true, fontSize:24, color:col });
    txt(s, fn, { x:x+0.35, y:y+0.85, w:w-0.7, h:0.3, fontFace:M, fontSize:12, color:col });
    txt(s, b, { x:x+0.35, y:y+1.3, w:w-0.7, h:1.6, fontSize:14, color:C.text, lineSpacingMultiple:1.2 });
    txt(s, foot, { x:x+0.35, y:y+3.0, w:w-0.7, h:0.65, fontSize:11.5, color:C.muted, lineSpacingMultiple:1.15 });
  });
  card(s, X0, 5.9, W-1.4, 0.85, C.panel2, C.panel2);
  txt(s, [
    { text:"정직하게  ", options:{ bold:true, color:C.amber } },
    { text:"손실 한도는 “넘는 순간 멈춤”이 아닙니다. 가격이 한 번에 크게 움직이면 동결 시점 손실이 한도를 넘습니다 (10-06 테스트넷 데모: 한도 3%, 동결 시 4.24%). 보장하는 것은 위반 뒤에 새 위험이 더 쌓이지 않는다는 것입니다." },
  ], { x:X0+0.35, y:5.9, w:W-2.1, h:0.85, fontSize:13.5, valign:"middle", lineSpacingMultiple:1.15 });
}

// 9 Why Monad
{
  const s = base("왜 모나드인가", "가격 유효시간 조건은 체인이 지킬 수 있어야 합니다");
  txt(s, "maxMarkAgeSeconds = 4초인 볼트: 4초보다 오래된 가격으로는 주문을 받지 않습니다. 가격은 블록에 실려야 갱신되므로, 블록 간격이 이 조건의 바닥이 됩니다.", { x:X0, y:1.6, w:11.9, h:0.7, fontSize:15, color:C.muted, lineSpacingMultiple:1.2 });
  const lane = (y, label, every, col, note) => {
    txt(s, label, { x:X0, y, w:3.2, h:0.4, bold:true, fontSize:17, color:col });
    txt(s, note, { x:X0, y:y+0.42, w:3.2, h:0.6, fontSize:12, color:C.muted });
    const x0 = 4.0, span = 8.6, secs = 36;
    s.addShape(pres.shapes.RECTANGLE, { x:x0, y:y+0.25, w:span, h:0.5, fill:{ color:C.panel }, line:{ color:C.line, width:0.5 } });
    for (let t = 0; t < secs; t += every) {
      const okW = Math.min(4, every, secs - t) / secs * span;
      s.addShape(pres.shapes.RECTANGLE, { x:x0 + t / secs * span, y:y+0.25, w:okW, h:0.5, fill:{ color:C.green, transparency:35 }, line:{ type:"none" } });
      if (every > 4) s.addShape(pres.shapes.RECTANGLE, { x:x0 + (t + 4) / secs * span, y:y+0.25, w:Math.min(every - 4, secs - t - 4) / secs * span, h:0.5, fill:{ color:C.red, transparency:55 }, line:{ type:"none" } });
    }
  };
  lane(2.6, "12초 블록 체인", 12, C.red, "가격 갱신 12초마다\n각 구간의 2/3는 MarkTooOld");
  lane(3.95, "Monad", 1, C.green, "가격 갱신 1초마다 (데모)\n항상 통과");
  txt(s, "36초 구간", { x:4.0, y:5.05, w:8.6, h:0.3, fontFace:M, fontSize:10, color:C.dim, align:"right" });
  s.addShape(pres.shapes.RECTANGLE, { x:4.0, y:5.12, w:0.18, h:0.14, fill:{ color:C.green, transparency:35 }, line:{ type:"none" } });
  txt(s, "주문 가능", { x:4.25, y:5.05, w:1.2, h:0.3, fontSize:10.5, color:C.muted });
  s.addShape(pres.shapes.RECTANGLE, { x:5.4, y:5.12, w:0.18, h:0.14, fill:{ color:C.red, transparency:55 }, line:{ type:"none" } });
  txt(s, "가격이 낡아 취소", { x:5.65, y:5.05, w:1.8, h:0.3, fontSize:10.5, color:C.muted });
  card(s, X0, 5.6, W-1.4, 1.15, C.panel2, C.panel2);
  txt(s, "조건은 체인이 가격을 새로 쓸 수 있는 만큼만 요구할 수 있습니다. 짧은 가격 유효시간을 실제로 강제할 수 있는 체인이어서 Monad 위에 만듭니다. 실제 거래소 Perpl의 마크도 Monad 위에서 측정해 보니 1~50초 전 값이었고, Perpl 자신도 60초 넘은 가격은 거부합니다.", { x:X0+0.35, y:5.6, w:W-2.1, h:1.15, fontSize:14.5, valign:"middle", lineSpacingMultiple:1.2 });
}

// 10 Perpl
{
  const s = base("실제 거래소", "실제 거래소 연결: Perpl 어댑터");
  const L = [
    ["가격을 운영자가 정하지 않음", "Perpl이 체인에 쓰는 마크와 그 타임스탬프를 그대로 씁니다. 가격 유효시간 검사가 실제 거래소의 시계로 돌아갑니다."],
    ["볼트마다 Perpl 계정 하나", "마진은 거래하는 순간에만 볼트에서 Perpl로 가고, 남는 돈은 바로 돌아옵니다. 출금 대상은 그 볼트뿐입니다."],
    ["전부 체결 아니면 취소", "주문은 지정가에 즉시·전량 체결로만 냅니다. 거래소가 보고한 포지션이 예상과 다르면 트랜잭션 전체를 되돌립니다."],
    ["에이전트 코드는 그대로", "mock 거래소와 같은 주문 형식이라 에이전트를 바꿀 필요가 없습니다."],
  ];
  L.forEach(([h, b], i) => {
    const y = 1.85 + i * 1.18;
    txt(s, h, { x:X0, y, w:6.8, h:0.4, bold:true, fontSize:17 });
    txt(s, b, { x:X0, y:y+0.42, w:6.8, h:0.7, fontSize:13, color:C.muted, lineSpacingMultiple:1.15 });
  });
  const x = 8.0, y = 1.85, w = 4.63;
  card(s, x, y, w, 4.9, C.panel2, C.line);
  txt(s, "Monad 테스트넷 포크 테스트", { x:x+0.35, y:y+0.3, w:w-0.7, h:0.4, bold:true, fontSize:16, color:C.acc });
  const st = ["누구나 등록 (createMandate)", "500 aUSD 입금", "0.001 BTC 롱, Perpl에 기록", "한도 넘는 주문은 Perpl 전에 거부", "롱에서 숏으로 전환", "보유 시간 초과로 동결", "청산 끝까지, Perpl 계정 비움", "배분자 전액 출금"];
  txt(s, st.map((t, k) => ({ text:t, options:{ bullet:{ type:"number" }, breakLine:k < st.length-1 } })), { x:x+0.35, y:y+0.85, w:w-0.6, h:2.9, fontSize:13, color:C.text, paraSpaceAfter:4 });
  txt(s, "10회 연속 통과 (2026-10-06)\n같은 날 테스트넷 배포, Perpl에서 체결 10건,\n한도 초과 주문 5건 온체인 거부", { x:x+0.35, y:y+3.9, w:w-0.7, h:0.8, fontSize:12.5, color:C.amber, lineSpacingMultiple:1.2 });
}

// 11 Demo
{
  const s = base("데모", "데모 영상");
  s.addMedia({ type:"video", path:process.env.VIDEO || "mandate-demo-ko.mp4", cover:"data:image/png;base64,"+require("fs").readFileSync(process.env.COVER || "cover.png").toString("base64"), x:X0, y:1.55, w:9.0, h:5.06 });
  const D = ["Launch로 새 에이전트 등록", "조건표 확인", "1,000 USDC 입금", "한도 안 주문 통과, 넘는 주문 거부", "−2% 충격, poke로 동결", "unwind 청산, 출금", "탐색기에서 트랜잭션 확인"];
  txt(s, "영상 순서", { x:10.05, y:1.6, w:2.6, h:0.35, bold:true, fontSize:15, color:C.acc });
  txt(s, D.map((t, k) => ({ text:t, options:{ bullet:{ type:"number" }, breakLine:k < D.length-1 } })), { x:10.05, y:2.05, w:2.6, h:3.6, fontSize:12.5, color:C.text, paraSpaceAfter:6 });
  txt(s, "2분 59초 · 테스트넷 공개 데모\n거래소와 USDC는 mock", { x:10.05, y:5.85, w:2.6, h:0.75, fontSize:11, color:C.muted });
}

// 12 Results
{
  const s = base("결과", "만든 것과 확인한 것");
  const N = [
    ["돈", "에이전트는 돈을 못 꺼낸다", "주문만 낼 수 있고, 출금은 맡긴 사람만. 묶인 몫은 요청 1일 뒤 누구나 줄여 현금화"],
    ["한도", "넘는 주문은 미리 막힌다", "거래소에 닿기 전에 컨트랙트가 조건을 검사하고 거부한다"],
    ["정지", "단계별로 멈춘다", "하루 손실은 일시정지, 가격 끊김은 정지, 큰 손실은 동결. 포지션은 누구나 나눠 정리"],
    ["공개", "지금 직접 해 볼 수 있다", "모나드 테스트넷 공개 데모. 모든 동작이 트랜잭션으로 남는다"],
  ];
  const w = (W - 1.4 - 0.75) / 4;
  N.forEach(([v, l, d], i) => {
    const x = X0 + i * (w + 0.25), y = 1.85;
    card(s, x, y, w, 2.55);
    txt(s, v, { x:x+0.3, y:y+0.3, w:w-0.6, h:0.8, bold:true, fontSize:36, color:C.acc });
    txt(s, l, { x:x+0.3, y:y+1.1, w:w-0.5, h:0.45, bold:true, fontSize:15.5 });
    txt(s, d, { x:x+0.3, y:y+1.6, w:w-0.5, h:0.85, fontSize:12, color:C.muted, lineSpacingMultiple:1.15 });
  });
  txt(s, "어떻게 확인했나", { x:X0, y:4.7, w:6, h:0.4, bold:true, fontSize:17, color:C.acc });
  const B = [
    "자동 테스트 197개가 코드를 바꿀 때마다 돈다 (컨트랙트 128, 데모 서버 69)",
    "함수를 무작위 순서로 수없이 불러도 \"돈은 새지 않는다\" 같은 규칙이 깨지지 않는지 검사",
    "실제 Perpl 거래소를 복사한 환경에서 입금부터 출금까지 10번 연속 성공",
    "Monad 테스트넷의 실제 Perpl에서 에이전트 스크립트가 짧게 3회(약 1시간) 거래, 한도 넘는 주문 5번은 체인에서 거부",
  ];
  txt(s, B.map((t, k) => ({ text:t, options:{ bullet:{ indent:14 }, breakLine:k < B.length-1 } })), { x:X0, y:5.2, w:W-1.4, h:1.6, fontSize:15, color:C.text, paraSpaceAfter:8 });
}

// 13 Limits
{
  const s = base("한계", "아직 아닌 것");
  const demo = [
    "거래소와 USDC는 가짜(mock)다",
    "가격은 우리 서버가 넣는다",
    "실제 거래소(Perpl) 연결은 테스트넷에서 소액(0.001 BTC, 짧은 실행 3회)으로만 확인했다",
  ];
  const not = [
    "전략이 돈을 번다는 것. 조건은 행동을 제한할 뿐이다",
    "손실이 정확히 한도에서 멈춘다는 것. 급락하면 넘을 수 있다",
    "묶인 돈을 바로 뺄 수 있다는 것. 요청 뒤 1일 대기",
  ];
  const col = (x, h, color, items) => {
    card(s, x, 1.85, 5.85, 3.0);
    txt(s, h, { x:x+0.4, y:2.15, w:5, h:0.45, bold:true, fontSize:21, color });
    txt(s, items.map((t, k) => ({ text:t, options:{ bullet:{ indent:14 }, breakLine:k < items.length-1 } })), { x:x+0.4, y:2.8, w:5.1, h:1.9, fontSize:16, color:C.text, paraSpaceAfter:14, lineSpacingMultiple:1.1 });
  };
  col(X0, "데모라서 다른 점", C.amber, demo);
  col(X0 + 6.1, "보장하지 않는 것", C.red, not);
}

// 14 Close
{
  const s = pres.addSlide(); n++;
  s.background = { color: C.bg };
  txt(s, "Mandate", { x:X0, y:2.3, w:10, h:1.2, bold:true, fontSize:64 });
  txt(s, "믿음 대신 잠긴 조건으로 맡기는 자본", { x:X0, y:3.55, w:11, h:0.6, bold:true, fontSize:26, color:C.acc });
  txt(s, "github.com/jiwon000/mandate", { x:X0, y:4.6, w:8, h:0.35, fontFace:M, fontSize:14, color:C.muted });
  txt(s, "Solidity · Hardhat 3 · Foundry · OpenZeppelin 5.4 · ethers 6 · Monad 테스트넷", { x:X0, y:6.85, w:11, h:0.3, fontFace:M, fontSize:10, color:C.dim });
}

pres.writeFile({ fileName: "mandate-club-talk.pptx" }).then((f) => console.log("wrote", f, n));

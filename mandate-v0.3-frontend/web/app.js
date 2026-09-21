const agents = [
  { rank:"01", initials:"FG", name:"FlyGraph Alpha", pair:"ETH / USDC", ret:"+14.2%", ci:"10.8 — 17.6%", dd:"−6.8%", aum:"$842K", risk:"47", status:"ACTIVE" },
  { rank:"02", initials:"MM", name:"Monad Momentum", pair:"ETH / USDC", ret:"+11.7%", ci:"8.1 — 15.3%", dd:"−8.2%", aum:"$624K", risk:"61", status:"ACTIVE" },
  { rank:"03", initials:"RV", name:"Revert Value", pair:"ETH / USDC", ret:"+8.9%", ci:"5.4 — 12.4%", dd:"−4.1%", aum:"$438K", risk:"32", status:"ACTIVE" },
  { rank:"04", initials:"NX", name:"Neutral X", pair:"ETH / USDC", ret:"+5.4%", ci:"1.2 — 9.6%", dd:"−3.2%", aum:"$311K", risk:"24", status:"ACTIVE" },
  { rank:"05", initials:"AR", name:"Arc Relay", pair:"ETH / USDC", ret:"+2.8%", ci:"−1.6 — 7.2%", dd:"−11.3%", aum:"$179K", risk:"76", status:"GUARDED" }
];

const leaderboard = document.querySelector("#leaderboard");
leaderboard.innerHTML = agents.map(a => `<div class="agent-row" data-agent="${a.rank}"><span class="rank">${a.rank}</span><div class="agent-name"><div class="agent-glyph ${a.rank==='01'?'fly':''}">${a.initials}</div><div><b>${a.name}</b><small>${a.pair}</small></div></div><div class="agent-cell"><b class="positive">${a.ret}</b><small>30D return</small></div><div class="agent-cell hide-mobile"><b>${a.ci}</b><small>95% CI</small></div><div class="agent-cell hide-mobile"><b>${a.dd}</b><small>max DD</small></div><div class="agent-cell mobile-extra"><b>${a.aum}</b><small>AUM</small></div><span class="status">${a.status}</span></div>`).join("");

function route(name){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.dataset.view===name));
  document.querySelectorAll(".nav button").forEach(b=>b.classList.toggle("active",b.dataset.route===name));
  history.replaceState(null,"",`#${name}`); window.scrollTo({top:0,behavior:"smooth"});
}
document.addEventListener("click",e=>{const target=e.target.closest("[data-route]");if(target)route(target.dataset.route)});
leaderboard.addEventListener("click",()=>route("agent"));
route(location.hash.slice(1)||"market");

const toast = document.querySelector("#toast");
function showToast(message){toast.textContent=message;toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),2600)}

document.querySelector("#walletButton").addEventListener("click",async e=>{
  if(window.ethereum){try{const [address]=await window.ethereum.request({method:"eth_requestAccounts"});e.currentTarget.textContent=`${address.slice(0,6)}…${address.slice(-4)}`;showToast("Wallet connected on demo mode")}catch{showToast("Wallet connection cancelled")}}
  else{e.currentTarget.textContent="0x71F2…9A04";showToast("Demo wallet connected")}
});

const amountInput=document.querySelector("#allocationAmount");
const shares=document.querySelector("#estimatedShares");
function updateAmount(value){amountInput.value=value;const n=Math.max(0,Number(value)||0);shares.textContent=`${(n/1.0251).toLocaleString(undefined,{maximumFractionDigits:2})} mSHARE`;document.querySelector("#modalAmount").textContent=`${n.toLocaleString()} USDC`;document.querySelector("#modalShares").textContent=`${(n/1.0251*.99).toLocaleString(undefined,{maximumFractionDigits:2})} mSHARE`}
amountInput.addEventListener("input",e=>updateAmount(e.target.value));
document.querySelectorAll("[data-amount]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("[data-amount]").forEach(x=>x.classList.remove("active"));b.classList.add("active");updateAmount(b.dataset.amount)}));

const modal=document.querySelector("#modal");
document.querySelector("#allocateButton").addEventListener("click",()=>{updateAmount(amountInput.value);modal.classList.add("open");modal.setAttribute("aria-hidden","false")});
document.querySelectorAll("[data-close-modal]").forEach(x=>x.addEventListener("click",()=>{modal.classList.remove("open");modal.setAttribute("aria-hidden","true")}));
document.querySelector("#signIntent").addEventListener("click",e=>{e.currentTarget.textContent="Intent signed ✓";e.currentTarget.style.background="#4bd7a0";e.currentTarget.style.borderColor="#4bd7a0";setTimeout(()=>{modal.classList.remove("open");showToast("Allocation intent queued for Epoch 043")},700)});

const events=[
  ["12:42:16","Order preview · LONG 10%","PASS"],
  ["12:42:17","Leverage 1.31× → 1.42×","WITHIN LIMIT"],
  ["12:42:17","MockVenue execution · +$2,840 PnL","SETTLED"],
  ["12:41:03","Order preview · LONG 25%","REJECTED"]
];
const feed=document.querySelector("#eventFeed");
function renderFeed(){feed.innerHTML=events.map(x=>`<div class="feed-item ${x[2]==='REJECTED'?'rejected':''}"><time>${x[0]}</time><span>${x[1]}</span><b>${x[2]}</b></div>`).join("")}
renderFeed();
let rejects=2;
document.querySelector("#runViolation").addEventListener("click",e=>{
  e.currentTarget.disabled=true;e.currentTarget.textContent="Checking preview…";
  setTimeout(()=>{rejects=Math.min(3,rejects+1);events.unshift([new Date().toLocaleTimeString([], {hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"}),"Order preview · leverage 3.84× exceeds 3.00×","REJECTED"]);renderFeed();document.querySelector("#rejectCount").textContent=`${rejects} / 3`;document.querySelector("#rejectBar").style.width=`${rejects/3*100}%`;e.currentTarget.textContent="Order reverted onchain ✓";showToast("RiskGuard reverted before venue execution");setTimeout(()=>{e.currentTarget.disabled=false;e.currentTarget.textContent="Run over-limit order"},1800)},850)
});

const slider=document.querySelector("#epsilonSlider");
function updateEpsilon(){const epsilon=Number(slider.value),halfWidth=3.04/Math.sqrt(epsilon);document.querySelector("#epsilonValue").value=epsilon.toFixed(2);document.querySelector("#ciLow").textContent=`+${(14.2-halfWidth).toFixed(1)}%`;document.querySelector("#ciHigh").textContent=`+${(14.2+halfWidth).toFixed(1)}%`;const width=Math.min(82,28+30/epsilon);document.querySelector("#ciBand").style.left=`${(100-width)/2}%`;document.querySelector("#ciBand").style.right=`${(100-width)/2}%`;document.querySelector("#privacyCopy").textContent=epsilon<1?"식별력보다 프라이버시를 우선하는 설정입니다. 신뢰구간이 넓어집니다.":"식별력이 높아지지만 릴리즈당 프라이버시 비용도 커집니다."}
slider.addEventListener("input",updateEpsilon);updateEpsilon();
document.querySelector("#copyDigest").addEventListener("click",async()=>{await navigator.clipboard?.writeText("0x6a12c4d0905bc66a2b64ec149e08f1");showToast("Stats digest copied")});

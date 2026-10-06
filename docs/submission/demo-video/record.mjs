// Records the demo on the hosted Monad testnet build. One take, no captions:
// captions and narration go on per language in mux.mjs, so KO and EN share the
// same on-chain run. Scene length = the longer of the two narrations + 0.8s.
import { chromium } from "playwright-core";
import { Wallet, JsonRpcProvider, Network } from "ethers";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE || "https://mandate-e4kb.onrender.com/";
const RPC = process.env.RPC || "https://testnet-rpc.monad.xyz";
// The browser-wallet key pays gas for Launch. It lives outside the repo.
const KEY_FILE = process.env.KEY_FILE;
const SCENES = 9;
const LABEL = process.env.LABEL || "Monad testnet";
const len = (dir, i) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${dir}/s${i}.aiff`]).toString());
const dur = [...Array(SCENES).keys()].map((i) => Math.max(len("audio-ko", i), len("audio-en", i)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CHAIN_ID=31337 for a local chain. A fixed network keeps ethers from re-probing the RPC.
const net = Network.from(Number(process.env.CHAIN_ID || 10143));
const rpc = new JsonRpcProvider(RPC, net, { staticNetwork: net });
// ONLY=1,7 re-records just those scenes; mux takes each scene from its own take.
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map(Number) : null;
async function retry(f, n = 4) {
  for (let k = 1; ; k++) {
    try { return await f(); } catch (e) {
      if (k >= n || e.code === "CALL_EXCEPTION") throw e;
      log("rpc retry", k, e.shortMessage ?? e.message);
      await sleep(1500 * k);
    }
  }
}
const wallet = new Wallet(JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))[0].private_key, rpc);
const chainHex = "0x" + (await rpc.getNetwork()).chainId.toString(16);
const sent = [];

const OVERLAY = () => {
  if (document.getElementById("__cur")) return;
  const css = document.createElement("style");
  css.textContent = `
  #__cur{position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;transition:left .55s cubic-bezier(.3,.7,.2,1),top .55s cubic-bezier(.3,.7,.2,1);left:640px;top:360px}
  #__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
  .__ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ffd23f;border-radius:10px;box-shadow:0 0 0 4px rgba(255,210,63,.25),0 0 24px rgba(255,210,63,.55);transition:opacity .3s}
  .__ripple{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ffd23f;animation:__rp .6s ease-out forwards}
  @keyframes __rp{to{transform:scale(4);opacity:0}}
  #__act{position:fixed;z-index:2147483647;right:18px;top:74px;padding:7px 12px;border-radius:7px;background:#ffd23f;color:#111;font:600 14px/1.2 ui-monospace,Menlo,monospace;pointer-events:none;opacity:0;transition:opacity .25s}
  .toast{bottom:auto!important;top:90px}`;
  document.head.appendChild(css);
  const cur = document.createElement("div");
  cur.id = "__cur";
  cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.8L8.6 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const act = Object.assign(document.createElement("div"), { id: "__act" });
  document.body.append(cur, act);
  window.__action = (t) => { act.textContent = t || ""; act.style.opacity = t ? 1 : 0; };
  window.__point = (el) => {
    const r = el.getBoundingClientRect();
    cur.style.left = r.left + r.width / 2 + "px";
    cur.style.top = r.top + r.height / 2 + "px";
    const ring = Object.assign(document.createElement("div"), { className: "__ring" });
    Object.assign(ring.style, { left: r.left - 6 + "px", top: r.top - 6 + "px", width: r.width + 12 + "px", height: r.height + 12 + "px" });
    document.body.appendChild(ring);
    return ring;
  };
  window.__ripple = (el) => {
    const r = el.getBoundingClientRect();
    const d = Object.assign(document.createElement("div"), { className: "__ripple" });
    Object.assign(d.style, { left: r.left + r.width / 2 + "px", top: r.top + r.height / 2 + "px" });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 700);
  };
};

// A minimal EIP-1193 wallet: the page asks, Node signs with the recording key.
const PROVIDER = () => {
  const listeners = {};
  window.ethereum = {
    request: ({ method, params }) => window.__eth(method, params ?? []).then((r) => {
      if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    }),
    on: (e, f) => ((listeners[e] ??= []).push(f)),
    removeListener() {}
  };
};

// Headful: the explorer's bot check turns away headless Chrome.
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: false, args: ["--window-size=1280,800"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "raw", size: { width: 1280, height: 720 } } });
await context.exposeFunction("__eth", async (method, params) => {
  try {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return { result: [wallet.address] };
    if (method === "eth_chainId") return { result: chainHex };
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return { result: null };
    if (method === "eth_sendTransaction") {
      const t = params[0];
      const tx = await retry(() => wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0, gasLimit: t.gas ?? t.gasLimit }));
      sent.push(tx.hash);
      log("sent", tx.hash);
      return { result: tx.hash };
    }
    return { result: await retry(() => rpc.send(method, params)) };
  } catch (e) {
    return { error: { message: e.shortMessage ?? e.message, code: e.code === "ACTION_REJECTED" ? 4001 : -32000 } };
  }
});
await context.addInitScript(PROVIDER);
const page = await context.newPage();
const T0 = Date.now();
const now = () => (Date.now() - T0) / 1000;
const segs = [];
const log = (...a) => console.log(now().toFixed(1), ...a);

const setup = () => page.evaluate(OVERLAY);
async function click(sel, label, { hold = 700, after = 500 } = {}) {
  const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
  await loc.scrollIntoViewIfNeeded();
  await sleep(250);
  const h = await loc.elementHandle();
  await page.evaluate(([el, l]) => { window.__action(l); window.__ring = window.__point(el); }, [h, label]);
  await sleep(hold);
  await page.evaluate((el) => window.__ripple(el), h);
  await loc.click();
  await sleep(after);
  await page.evaluate(() => { window.__ring?.remove(); window.__action(""); });
}
async function point(sel, label, ms = 2500) {
  const h = await page.locator(sel).first().elementHandle();
  await page.evaluate(([el, l]) => { window.__action(l); window.__ring = window.__point(el); }, [h, label]);
  await sleep(ms);
  await page.evaluate(() => { window.__ring?.remove(); window.__action(""); });
}
const bodyHas = (text, timeout = 60000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }).then(() => true, () => false);
const count = (text) => page.evaluate((t) => document.querySelector("#eventFeed")?.innerText.split(t).length - 1, text);
const nav = (route, label) => click(`.nav [data-route="${route}"]`, label ?? route);
async function smoothScroll(px, steps = 20, ms = 60) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await sleep(ms); }
}
// Orders and poke need a mark younger than Tight Mandate's 10s limit. Send
// right after the oracle's next mark rather than late in its cycle.
async function freshMark(maxAge = 3, timeout = 60000) {
  const ok = await page.waitForFunction((m) => {
    const t = document.querySelector('.agent-row[aria-label="Open Tight Mandate"] [data-cell="age"]')?.textContent ?? "";
    const age = parseInt(t, 10);
    return Number.isFinite(age) && age <= m;
  }, maxAge, { timeout, polling: 250 }).then(() => true, () => false);
  if (!ok) log("no fresh mark within", timeout / 1000, "s");
}
async function scene(i, fn) {
  if (ONLY && !ONLY.includes(i)) return;
  const start = now();
  log("scene", i, "start");
  await fn();
  const need = dur[i] + 0.8;
  const spent = now() - start;
  if (spent < need) await sleep((need - spent) * 1000);
  segs.push({ i, start, end: now() });
  log("scene", i, "end", (now() - start).toFixed(1), "need", need.toFixed(1));
}

await page.goto(BASE);
await bodyHas(LABEL, 120000);
await sleep(4000);
await setup();
await page.mouse.move(640, 360);

await scene(0, async () => {
  await sleep(1500);
  await point("#chainLabel", "Monad testnet · 10143", 3000);
  await smoothScroll(520, 25, 80);
  await sleep(3500);
  await smoothScroll(-520, 15, 60);
});

let launched = null;
await scene(1, async () => {
  await click("#walletButton", "Connect");
  await click("#walletInjected", "Browser wallet");
  await bodyHas("connected from your wallet", 30000);
  await nav("launch", "Launch");
  await click('[data-preset="balanced"]', "Balanced preset");
  await smoothScroll(700, 25, 90);
  await sleep(800);
  await click("#launchButton", "createMandate()", { after: 300 });
  const ok = await bodyHas("is live with terms", 90000);
  launched = sent.at(-1);
  log("launch ok", ok, launched);
});

await scene(2, async () => {
  await nav("market", "Market");
  await click('.agent-row[aria-label="Open Tight Mandate"]', "Tight Mandate");
  await page.locator("#termSheet").scrollIntoViewIfNeeded();
  await sleep(600);
  await smoothScroll(500, 20, 120);
});

await scene(3, async () => {
  await click("#walletButton", "Switch account");
  await click("#walletDemo", "Demo allocator");
  await nav("allocate", "Allocate");
  await click('[data-amount="1000"]', "1,000 USDC");
  await click("#allocateButton", "Review allocation");
  await freshMark(2);
  await click("#signIntent", "approve() + allocate()");
  const ok = await bodyHas("Allocated", 60000);
  log("allocate ok", ok);
});

await scene(4, async () => {
  await nav("risk", "Live Risk");
  const before = await count("REVERTED");
  await freshMark();
  await click("#compliantOrder", "Send order inside mandate");
  await page.waitForFunction(() => !document.querySelector("#compliantOrder")?.disabled, null, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  await freshMark();
  await click("#runViolation", "Send over-limit order");
  await page.waitForFunction((b) => (document.querySelector("#eventFeed")?.innerText.split("REVERTED").length - 1) > b, before, { timeout: 30000 }).catch(() => log("no revert seen"));
  await sleep(1200);
});

await scene(5, async () => {
  await click('[data-shock="-200"]', "−2% shock");
  const over = await page.waitForFunction(() => document.querySelector('.agent-row[aria-label="Open Tight Mandate"] [data-cell="dd"]')?.classList.contains("breached"), null, { timeout: 45000, polling: 250 }).then(() => true, () => false);
  log("over", over);
  await sleep(800);
  await freshMark();
  await click("#pokeButton", "poke()");
  const frozen = await bodyHas("FROZEN", 60000);
  log("frozen", frozen);
  await sleep(1500);
  await click("#compliantOrder", "Send order inside mandate");
  await bodyHas("AgentNotActive", 30000);
});

await scene(6, async () => {
  await freshMark();
  await click("#unwindButton", "unwind()");
  await page.waitForFunction(() => !document.querySelector("#unwindButton")?.disabled, null, { timeout: 30000 }).catch(() => {});
  await freshMark();
  await click("#unwindButton", "unwind()");
  await page.waitForFunction(() => !document.querySelector("#unwindButton")?.disabled, null, { timeout: 30000 }).catch(() => {});
  await nav("allocate", "Allocate");
  await freshMark(2);
  await click("#withdrawButton", "Withdraw all shares");
  await sleep(5000);
});

// The feed links each line to monadscan. Open the poke's transaction, then the
// vault launched in scene 1, in the same tab so the recording stays one file.
await scene(7, async () => {
  if (ONLY && !ONLY.includes(5)) return vaultPage("https://testnet.monadscan.com");
  await nav("risk", "Live Risk");
  const link = page.locator("#eventFeed .feed-item", { hasText: /poke|frozen/i }).locator("time a").first();
  const any = page.locator("#eventFeed time a").first();
  const target = (await link.count()) ? link : (await any.count()) ? any : null;
  if (!target) return log("no explorer link: local chain");
  const href = await target.getAttribute("href");
  await click(target, "View on monadscan", { after: 0 }).catch(() => {});
  for (const p of context.pages()) if (p !== page) await p.close();
  if (!href) return log("no explorer link: local chain");
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await bodyHas("Success", 30000);
  await setup();
  await hideBanner();
  await point("text=Success", "Status: Success", 3500).catch(() => sleep(3500));
  await vaultPage(new URL(href).origin);
});
async function vaultPage(origin) {
  const receipt = launched && (await retry(() => rpc.getTransactionReceipt(launched)));
  const vault = receipt?.logs.find((l) => l.address.toLowerCase() === "0xa616314b13c636e728d705bcd2ece867398b8fa0".toLowerCase() && l.topics.length > 1);
  const vaultAddr = vault ? "0x" + vault.topics[1].slice(26) : null;
  log("launched vault", vaultAddr);
  if (vaultAddr) {
    await page.goto(origin + "/address/" + vaultAddr, { waitUntil: "domcontentloaded" });
    await bodyHas("Contract", 30000);
    await setup();
    await hideBanner();
    await sleep(4000);
  }
}
async function hideBanner() {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button, a")) {
      if (/^got it!?$/i.test(b.textContent.trim())) {
        let n = b;
        while (n.parentElement && getComputedStyle(n).position !== "fixed") n = n.parentElement;
        (n.parentElement ? n : b).style.display = "none";
      }
    }
  });
}

await scene(8, async () => {
  await page.goto(BASE);
  await bodyHas(LABEL, 60000);
  await setup();
  await sleep(1500);
});

const video = page.video();
await context.close();
await browser.close();
const out = `raw/take-${Date.now()}.webm`;
fs.renameSync(await video.path(), out);
fs.writeFileSync(process.env.SEGS || "segs.json", JSON.stringify({ video: out, segs, sent, launched }, null, 1));
log("saved", out);

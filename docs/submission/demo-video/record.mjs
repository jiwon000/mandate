import { chromium } from "playwright-core";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:3222/";
const dur = [...Array(9).keys()].map((i) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${process.env.AUD || "audio"}/s${i}.aiff`]).toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OVERLAY = () => {
  const css = document.createElement("style");
  css.textContent = `
  #__cur{position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;transition:left .55s cubic-bezier(.3,.7,.2,1),top .55s cubic-bezier(.3,.7,.2,1);left:640px;top:360px}
  #__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
  .__ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ffd23f;border-radius:10px;box-shadow:0 0 0 4px rgba(255,210,63,.25),0 0 24px rgba(255,210,63,.55);transition:opacity .3s}
  .__ripple{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ffd23f;animation:__rp .6s ease-out forwards}
  @keyframes __rp{to{transform:scale(4);opacity:0}}
  #__cap{position:fixed;z-index:2147483647;left:50%;bottom:22px;transform:translateX(-50%);max-width:1100px;padding:9px 16px;border-radius:8px;background:rgba(6,9,16,.86);color:#f4f6fb;font:600 22px/1.4 "Apple SD Gothic Neo",Inter,system-ui,sans-serif;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s}
  #__act{position:fixed;z-index:2147483647;right:18px;top:74px;padding:7px 12px;border-radius:7px;background:#ffd23f;color:#111;font:600 14px/1.2 ui-monospace,Menlo,monospace;pointer-events:none;opacity:0;transition:opacity .25s}`;
  document.head.appendChild(css);
  const cur = document.createElement("div");
  cur.id = "__cur";
  cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.8L8.6 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const cap = Object.assign(document.createElement("div"), { id: "__cap" });
  const act = Object.assign(document.createElement("div"), { id: "__act" });
  document.body.append(cur, cap, act);
  window.__caption = (t) => { cap.textContent = t || ""; cap.style.opacity = t ? 1 : 0; };
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

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "raw", size: { width: 1280, height: 720 } } });
const page = await context.newPage();
const T0 = Date.now();
const now = () => (Date.now() - T0) / 1000;
const segs = [];
const log = (...a) => console.log(now().toFixed(1), ...a);

async function setup() {
  await page.evaluate(OVERLAY);
}
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
const caption = (t) => page.evaluate((x) => window.__caption(x), t);
const bodyHas = (text, timeout = 30000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }).then(() => true, () => false);
const count = (text) => page.evaluate((t) => document.querySelector("#eventFeed")?.innerText.split(t).length - 1, text);
const nav = (route, label) => click(`.nav [data-route="${route}"]`, label ?? route);
async function smoothScroll(px, steps = 20, ms = 60) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await sleep(ms); }
}

const narr = JSON.parse(fs.readFileSync(process.env.CAPS || "scenes.json", "utf8"));
const CHUNKS = process.env.CHUNKS ? JSON.parse(fs.readFileSync(process.env.CHUNKS, "utf8")) : null;
async function scene(i, fn) {
  const start = now();
  const timers = [];
  if (CHUNKS) {
    for (const c of CHUNKS[i]) timers.push(setTimeout(() => caption(c.text).catch(() => {}), (0.3 + c.at) * 1000));
  } else await caption(narr[i]);
  log("scene", i, "start");
  await fn();
  const need = dur[i] + 0.8;
  const spent = now() - start;
  if (spent < need) await sleep((need - spent) * 1000);
  timers.forEach(clearTimeout);
  await caption("");
  segs.push({ i, start, end: now() });
  log("scene", i, "end", (now() - start).toFixed(1));
}

await page.goto(BASE);
await sleep(4000);
await setup();
await page.mouse.move(640, 360);

await scene(0, async () => {
  await sleep(2500);
  await smoothScroll(520, 25, 80);
  await sleep(4000);
  await smoothScroll(-520, 15, 60);
});

await scene(1, async () => {
  await click("#walletButton", "Connect");
  await click("#walletDemo", "Demo allocator");
  await nav("launch", "Launch");
  await click('[data-preset="balanced"]', "Balanced preset");
  await smoothScroll(700, 25, 90);
  await sleep(800);
  await click("#launchButton", "createMandate()", { after: 300 });
  const ok = await bodyHas("is live with terms", 40000);
  log("launch ok", ok);
});

await scene(2, async () => {
  await nav("market", "Market");
  await click('.agent-row[aria-label="Open Tight Mandate"]', "Tight Mandate");
  await page.locator("#termSheet").scrollIntoViewIfNeeded();
  await sleep(600);
  await smoothScroll(500, 20, 120);
});

await scene(3, async () => {
  await nav("allocate", "Allocate");
  await click('[data-amount="1000"]', "1,000 USDC");
  await click("#allocateButton", "Review allocation");
  await click("#signIntent", "approve() + allocate()");
  const ok = await bodyHas("Allocated", 25000);
  log("allocate ok", ok);
});

await scene(4, async () => {
  await nav("risk", "Live Risk");
  const before = await count("REVERTED");
  await click("#compliantOrder", "Send order inside mandate");
  await sleep(3500);
  await click("#runViolation", "Send over-limit order");
  await page.waitForFunction((b) => (document.querySelector("#eventFeed")?.innerText.split("REVERTED").length - 1) > b, before, { timeout: 20000 }).catch(() => log("no revert seen"));
  await sleep(1200);
});

await scene(5, async () => {
  await click('[data-shock="-200"]', "−2% shock");
  await bodyHas("OVER LIMIT", 15000);
  await sleep(1200);
  await click("#pokeButton", "poke()");
  const frozen = await bodyHas("FROZEN", 20000);
  log("frozen", frozen);
  await sleep(1500);
  await click("#compliantOrder", "Send order inside mandate");
  await bodyHas("AgentNotActive", 15000);
});

await scene(6, async () => {
  await click("#unwindButton", "unwind()");
  await sleep(2200);
  await click("#unwindButton", "unwind()");
  await sleep(2200);
  await nav("allocate", "Allocate");
  await click("#withdrawButton", "Withdraw all shares");
  await sleep(4000);
});

// Off camera: reset the demo so Tight Mandate is Active again for the cadence scene.
await nav("risk", "Live Risk");
await click("#redeployButton", "Reset demo");
await page.waitForFunction(() => /ACTIVE/i.test(document.querySelector("#guardHeadline")?.innerText ?? "") || !document.body.innerText.includes("FROZEN"), null, { timeout: 120000 }).catch(() => {});
await sleep(8000);
log("reset done");

await scene(7, async () => {
  await click("[data-blocktime=\"12\"]", "12s marks · 12s-block chain");
  let reverted = false;
  for (let k = 0; k < 4 && !reverted; k++) {
    await sleep(6500);
    const b = await count("MarkTooOld");
    await click("#compliantOrder", "Send order inside mandate");
    reverted = await page.waitForFunction((x) => (document.querySelector("#eventFeed")?.innerText.split("MarkTooOld").length - 1) > x, b, { timeout: 8000 }).then(() => true, () => false);
  }
  log("marktooold", reverted);
  await sleep(1200);
  await click('[data-blocktime="1"]', "1s marks · Monad");
  await sleep(2500);
  await click("#compliantOrder", "Send order inside mandate");
  await sleep(4000);
});

await scene(8, async () => {
  await nav("market", "Market");
  await sleep(1500);
});

const video = page.video();
await context.close();
await browser.close();
const raw = await video.path();
fs.writeFileSync(process.env.SEGS || "segs.json", JSON.stringify({ raw, segs }, null, 1));
log("done", raw);

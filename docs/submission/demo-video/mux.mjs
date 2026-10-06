// node mux.mjs ko|en [segs.json] -> ../mandate-demo-<lang>.mp4 and -silent.mp4
// Captions are rendered to transparent PNGs in Chrome and overlaid by ffmpeg,
// because this ffmpeg has neither drawtext nor libass.
import { chromium } from "playwright-core";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const lang = process.argv[2];
const { video, segs } = JSON.parse(fs.readFileSync(process.argv[3] || "segs.json", "utf8"));
const chunks = JSON.parse(fs.readFileSync(`chunks.${lang}.json`, "utf8"));
const len = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const work = `mux-${lang}`;
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(`<html><body style="margin:0;background:transparent"><div id="c" style="position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1100px;padding:9px 16px;border-radius:8px;background:rgba(6,9,16,.86);color:#f4f6fb;font:600 22px/1.4 'Apple SD Gothic Neo',Inter,system-ui,sans-serif;text-align:center"></div></body></html>`);
for (const [i, list] of chunks.entries())
  for (const [k, c] of list.entries()) {
    await page.evaluate((t) => (document.getElementById("c").textContent = t), c.text);
    await page.screenshot({ path: `${work}/c${i}-${k}.png`, omitBackground: true });
  }
await browser.close();

const parts = { voiced: [], silent: [] };
// A scene re-recorded in pieces lists them as parts: [{video, start, end}, ...].
function join(i, list) {
  const out = `${work}/join${i}.mp4`;
  const inputs = list.flatMap((p) => ["-ss", p.start.toFixed(3), "-to", p.end.toFixed(3), "-i", p.video]);
  const f = list.map((_, k) => `[${k}:v]setpts=PTS-STARTPTS,fps=30[j${k}]`).join(";") + ";" + list.map((_, k) => `[j${k}]`).join("") + `concat=n=${list.length}:v=1:a=0[v]`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f, "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out]);
  return { video: out, start: 0, end: list.reduce((s, p) => s + p.end - p.start, 0) };
}
for (const seg of segs) {
  // speed > 1 shortens a scene whose wait for a fresh mark outlasts its narration.
  const speed = seg.speed ?? 1;
  const { i, start, end, video: from } = seg.parts ? { i: seg.i, ...join(seg.i, seg.parts) } : seg;
  const audio = `audio-${lang}/s${i}.aiff`;
  const aEnd = 0.3 + len(audio);
  const list = chunks[i];
  const inputs = ["-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", from ?? video, "-i", audio];
  let chain = `[0:v]setpts=(PTS-STARTPTS)/${speed},fps=30[v0]`;
  list.forEach((c, k) => {
    inputs.push("-i", `${work}/c${i}-${k}.png`);
    const from = 0.3 + c.at;
    const to = k + 1 < list.length ? 0.3 + list[k + 1].at : aEnd;
    chain += `;[v${k}][${k + 2}:v]overlay=0:0:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'[v${k + 1}]`;
  });
  const vOut = `[v${list.length}]`;
  const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"];
  const voiced = `${work}/p${i}.mp4`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${chain};[1:a]adelay=300|300,apad,aresample=44100[a]`, "-map", vOut, "-map", "[a]", "-shortest", ...enc, "-c:a", "aac", "-b:a", "160k", "-ac", "2", voiced]);
  const silent = `${work}/q${i}.mp4`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", chain, "-map", vOut, ...enc, "-an", silent]);
  parts.voiced.push(voiced);
  parts.silent.push(silent);
  console.log(lang, i, len(voiced).toFixed(1));
}
for (const [kind, files] of Object.entries(parts)) {
  const listFile = `${work}/${kind}.txt`;
  fs.writeFileSync(listFile, files.map((f) => `file '${f.split("/").pop()}'`).join("\n"));
  const out = `${process.env.OUT || ".."}/mandate-demo-${lang}${kind === "silent" ? "-silent" : ""}.mp4`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out]);
  console.log(out, len(out).toFixed(1));
}

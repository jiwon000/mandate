// Narration -> per-scene audio and caption chunks.
// node tts.mjs ko|en  ->  audio-<lang>/s{i}.aiff and chunks.<lang>.json
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const lang = process.argv[2];
const scenes = JSON.parse(fs.readFileSync(lang === "ko" ? "scenes.ko.json" : "scenes.json", "utf8"));
const MAX = lang === "ko" ? 36 : 70;
const GAP = 0.25;
const READ = [["Mandate", "맨데이트"], ["USDC", "유에스디씨"], ["poke", "포크"], ["Perpl", "퍼플"], ["Monad", "모나드"], ["mock", "모의 구현"], ["Tight", "타이트"]];
const say = (text, out) => {
  const spoken = lang === "ko" ? READ.reduce((t, [a, b]) => t.split(a).join(b), text) : text;
  execFileSync("say", lang === "ko" ? ["-v", "Yuna", "-r", "200", "-o", out, spoken] : ["-v", "Samantha", "-r", "168", "-o", out, spoken]);
};
const len = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

// Sentences, then long sentences split at their last comma before MAX.
function chunks(text) {
  const out = [];
  for (const s of text.match(/[^.!?。]+[.!?。]+["”]?|[^.!?。]+$/g).map((x) => x.trim()).filter(Boolean)) {
    let rest = s;
    while (rest.length > MAX) {
      const cut = rest.lastIndexOf(", ", MAX);
      if (cut < 10) break;
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 2);
    }
    out.push(rest);
  }
  return out;
}

const dir = `audio-${lang}`;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/parts`, { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", String(GAP), "-c:a", "pcm_s16be", `${dir}/parts/gap.aiff`]);
const all = scenes.map((text, i) => {
  let at = 0;
  const list = [];
  const files = [];
  chunks(text).forEach((c, k) => {
    const f = `${dir}/parts/s${i}-${k}.aiff`;
    say(c, f);
    list.push({ text: c, at: Number(at.toFixed(2)) });
    at += len(f) + GAP;
    files.push(`file 'parts/s${i}-${k}.aiff'`, "file 'parts/gap.aiff'");
  });
  fs.writeFileSync(`${dir}/s${i}.txt`, files.slice(0, -1).join("\n"));
  execFileSync("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/s${i}.txt`, "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16be", `${dir}/s${i}.aiff`]);
  console.log(i, len(`${dir}/s${i}.aiff`).toFixed(1));
  return list;
});
fs.writeFileSync(`chunks.${lang}.json`, JSON.stringify(all, null, 1));

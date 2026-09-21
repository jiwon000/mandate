import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 3000);
const root = new URL(".", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, safe === "/" ? "index.html" : safe);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": types[".html"] });
    res.end(body);
  }
}).listen(port, () => console.log(`Mandate web running at http://localhost:${port}`));

// Serves the Mandate demo and proxies JSON-RPC to the chain the contracts
// live on, so the browser reads and writes real contract state.
//
//   npm run web         in-process chain (web/chain.mjs): deploys on boot, mines on demand
//   npm run web:live    a live RPC (web/live.mjs): MONAD_RPC_URL + DEMO_MNEMONIC,
//                       deployment from web/deployments/<chainId>.json
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startChain } from "./chain.mjs";
import { JsonRpcProvider } from "ethers";
import { deploymentFileFor, startLive } from "./live.mjs";
import { adoptLatestBook } from "./live-recover.mjs";
import { redactUrls, toRpcError } from "./rpc.mjs";
import { HttpError, IpLimiter, clientIp } from "./faucet.mjs";
import { createPerplReader } from "./perpl.mjs";

const port = Number(process.env.PORT || 3000);
// The real Perpl-testnet vault, read from the public testnet RPC and cached;
// independent of the chain this server runs.
const readPerpl = createPerplReader();
const root = fileURLToPath(new URL(".", import.meta.url));
const ethersBundle = fileURLToPath(
  new URL("../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url)
);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

// Exactly what the page loads; every other path is a 404, so nothing else in
// this directory (server code, deployment records) is ever served.
const staticFiles = {
  "/": ["index.html", types[".html"]],
  "/index.html": ["index.html", types[".html"]],
  "/styles.css": ["styles.css", types[".css"]],
  "/app.js": ["app.js", types[".js"]]
};

// The page's own origin, the Google font hosts, and the public RPC its wallet
// prompt offers. Its style attributes need 'unsafe-inline'; scripts do not.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://testnet-rpc.monad.xyz",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const number = (name, fallback) => Number(process.env[name] ?? fallback);
const logRequests = process.env.LOG_REQUESTS === "1";
// Per client, on top of the global buckets inside the chain: one visitor cannot
// spend everyone's market moves or hammer the upstream node through /rpc.
const controlLimit = new IpLimiter(number("CONTROL_IP_PER_MINUTE", 30));
const rpcLimit = new IpLimiter(number("RPC_IP_PER_MINUTE", 1200));
// Batch intents, settlement and leaderboard releases each cost the server's keys gas.
const writeLimit = new IpLimiter(number("WRITE_IP_PER_MINUTE", 30));

function limited(limiter, req) {
  const wait = limiter.take(clientIp(req));
  if (wait) throw Object.assign(new HttpError("too many requests; slow down", 429), { retryAfter: wait });
}

const liveMode = process.argv.includes("--live") || process.env.MANDATE_LIVE === "1";
let chain;
if (liveMode) {
  console.log(`Connecting to ${process.env.MONAD_RPC_URL ?? "(MONAD_RPC_URL unset)"}…`);
  // A restart on a host with a throwaway disk lands on the committed record;
  // pick up the newest book on chain first so it does not redeploy again.
  if (process.env.MONAD_RPC_URL && process.env.RECOVER_BOOK !== "0") {
    const rpc = new JsonRpcProvider(process.env.MONAD_RPC_URL, undefined, { batchMaxCount: 1 });
    const chainId = Number(await rpc.send("eth_chainId", []));
    await adoptLatestBook({
      request: ({ method, params }) => rpc.send(method, params),
      file: process.env.DEPLOYMENT_FILE ?? deploymentFileFor(chainId),
      log: (line) => console.log(line)
    });
    rpc.destroy();
  }
  chain = await startLive({
    rpcUrl: process.env.MONAD_RPC_URL,
    mnemonic: process.env.DEMO_MNEMONIC,
    adminToken: process.env.DEMO_ADMIN_TOKEN,
    deploymentFile: process.env.DEPLOYMENT_FILE
  });
} else {
  console.log("Compiling and deploying Mandate contracts to an in-process chain…");
  chain = await startChain();
}
const deployed = await chain.deployment();
console.log(`Chain ${deployed.chainId} ready. ${deployed.vaults.length} vaults live:`);
for (const vault of deployed.vaults) console.log(`  ${vault.name.padEnd(18)} ${vault.address}`);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        chunks.length = 0;
        reject(new HttpError("payload too large", 413)); // the socket is closed once the 413 is out
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError("request body is not valid JSON", 400);
  }
  if (typeof value !== "object" || value === null) throw new HttpError("request body must be a JSON object", 400);
  return value;
}

// Every POST changes chain state with the server's keys. A browser marks a request
// another site's page sent as cross-site; the demo's own page never sends one.
function sameSiteOnly(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError("cross-site requests are refused", 403);
}

// /api/control's status goes to every visitor, so its last oracle error leaves
// without any URL in it.
async function publicStatus() {
  const status = await chain.control.status();
  if (!status.oracle) return status;
  return { ...status, oracle: { ...status.oracle, lastError: redactUrls(status.oracle.lastError, process.env.MONAD_RPC_URL) } };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  res.writeHead(status, { "content-type": types[".json"], "cache-control": "no-store", ...headers });
  res.end(body);
}

// The batch allocator and the registry are part of every book the current
// deploy routine produces; a live server pointed at an older deployment record
// has neither, and says so instead of failing on an undefined handler.
function feature(name, label) {
  const api = chain[name];
  if (!api) {
    throw Object.assign(new Error(`this deployment has no ${label}; redeploy it with \`npm run deploy:demo\``), { httpStatus: 404 });
  }
  return api;
}

async function handleRpcCall(call) {
  const id = call?.id ?? null;
  try {
    const result = await chain.provider.request({ method: call.method, params: call.params ?? [] });
    return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: toRpcError(error) };
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  let pathname = "/";
  res.on("finish", () => {
    if (!logRequests && res.statusCode < 500) return;
    console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ${clientIp(req)}`);
  });

  try {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError("bad path", 400);
    }
    if (req.method === "POST") sameSiteOnly(req);

    if (pathname === "/rpc") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      limited(rpcLimit, req);
      const payload = await readJson(req);
      chain.touch();
      // Live mode answers eth_accounts / eth_sendTransaction itself and relays
      // the rest in one upstream batch; the local chain takes calls one by one.
      const response = chain.handleRpc
        ? await chain.handleRpc(payload)
        : Array.isArray(payload)
          ? await Promise.all(payload.map(handleRpcCall))
          : await handleRpcCall(payload);
      return sendJson(res, 200, response);
    }

    if (pathname === "/api/deployment") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
      chain.touch();
      return sendJson(res, 200, await chain.deployment());
    }

    if (pathname === "/api/perpl" && req.method === "GET") {
      try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 10_000).unref());
        return sendJson(res, 200, await Promise.race([readPerpl(), timeout]));
      } catch (error) {
        console.error("GET /api/perpl:", error?.shortMessage ?? error?.message);
        return sendJson(res, 502, { error: "Perpl testnet unavailable" });
      }
    }

    if (pathname === "/api/batch/status" && req.method === "GET") {
      return sendJson(res, 200, await feature("batch", "batch allocator").status());
    }

    if (pathname === "/api/batch/intent") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      limited(writeLimit, req);
      const body = await readJson(req);
      chain.touch();
      return sendJson(res, 200, await feature("batch", "batch allocator").submitIntent(body));
    }

    if (pathname === "/api/batch/settle") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      limited(writeLimit, req);
      chain.touch();
      return sendJson(res, 200, await feature("batch", "batch allocator").settle());
    }

    if (pathname === "/api/batch/claims" && req.method === "GET") {
      return sendJson(res, 200, await feature("batch", "batch allocator").claimsFor(url.searchParams.get("address")));
    }

    if (pathname === "/api/reporter/status" && req.method === "GET") {
      return sendJson(res, 200, await feature("reporter", "registry").status());
    }

    if (pathname === "/api/reporter/publish") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      limited(writeLimit, req);
      chain.touch();
      return sendJson(res, 200, await feature("reporter", "registry").publish());
    }

    // Test USDC for a visitor's own wallet, rate limited per address and per IP.
    if (pathname === "/api/faucet") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      chain.touch();
      const { address } = await readJson(req);
      return sendJson(res, 200, await feature("faucet", "faucet").drip({ address, ip: clientIp(req) }));
    }

    if (pathname === "/api/control") {
      chain.touch();
      if (req.method === "GET") return sendJson(res, 200, await publicStatus());
      if (req.method !== "POST") return sendJson(res, 405, { error: "GET or POST" });
      limited(controlLimit, req);
      const { op, value, token } = await readJson(req);
      let result;
      if (op === "blockTime") result = chain.control.setBlockTime(value);
      else if (op === "shock") result = chain.control.shock(value);
      else if (op === "restorePrice") result = chain.control.restorePrice();
      else if (op === "redeploy") result = await chain.control.redeploy(token);
      else return sendJson(res, 400, { error: "unknown op" });
      return sendJson(res, 200, { ...result, ...(await publicStatus()) });
    }

    if (pathname === "/vendor/ethers.js" && req.method === "GET") {
      const body = await readFile(ethersBundle);
      res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      return res.end(body);
    }

    const entry = req.method === "GET" || req.method === "HEAD" ? staticFiles[pathname] : undefined;
    if (!entry) throw new HttpError("not found", 404);
    const [name, type] = entry;
    const headers = { "content-type": type, "cache-control": "no-store" };
    if (type === types[".html"]) headers["content-security-policy"] = csp;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : await readFile(join(root, name)));
  } catch (error) {
    if (!error?.httpStatus) console.error(`${req.method} ${pathname}:`, error);
    if (res.headersSent) return res.end();
    const status = error?.httpStatus ?? 500;
    const headers = error?.retryAfter ? { "retry-after": String(error.retryAfter) } : {};
    if (status === 413) {
      headers.connection = "close";
      res.once("finish", () => req.destroy());
    }
    sendJson(res, status, { error: error?.httpStatus ? error.message : "internal error" }, headers);
  }
});

// A visitor that trickles its request in holds a socket; cut it off.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

// The local chain's /rpc signs for funded accounts, so it answers this machine only.
// Live mode sits behind a host's proxy and has its own signing allowlist. HOST overrides.
server.listen(port, process.env.HOST ?? (liveMode ? undefined : "127.0.0.1"), () => console.log(`\nMandate demo (${liveMode ? "live RPC" : "local chain"}) at http://localhost:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await chain.close();
    process.exit(0);
  });
}

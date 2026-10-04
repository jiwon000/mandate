// Serves the Mandate demo and proxies JSON-RPC to the chain the contracts
// live on, so the browser reads and writes real contract state.
//
//   npm run web         in-process chain (web/chain.mjs): deploys on boot, mines on demand
//   npm run web:live    a live RPC (web/live.mjs): MONAD_RPC_URL + DEMO_MNEMONIC,
//                       deployment from web/deployments/<chainId>.json
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { startChain } from "./chain.mjs";
import { startLive } from "./live.mjs";
import { toRpcError } from "./rpc.mjs";

const port = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL(".", import.meta.url));
const ethersBundle = fileURLToPath(
  new URL("../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url)
);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const liveMode = process.argv.includes("--live") || process.env.MANDATE_LIVE === "1";
let chain;
if (liveMode) {
  console.log(`Connecting to ${process.env.MONAD_RPC_URL ?? "(MONAD_RPC_URL unset)"}…`);
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
      if (size > 2_000_000) reject(new Error("payload too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  res.writeHead(status, { "content-type": types[".json"], "cache-control": "no-store" });
  res.end(body);
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
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === "/rpc") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      const payload = JSON.parse(await readBody(req));
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
      chain.touch();
      return sendJson(res, 200, await chain.deployment());
    }

    if (pathname === "/api/control") {
      chain.touch();
      if (req.method === "GET") return sendJson(res, 200, await chain.control.status());
      if (req.method !== "POST") return sendJson(res, 405, { error: "GET or POST" });
      const { op, value, token } = JSON.parse(await readBody(req));
      let result;
      if (op === "blockTime") result = chain.control.setBlockTime(value);
      else if (op === "shock") result = chain.control.shock(value);
      else if (op === "restorePrice") result = chain.control.restorePrice();
      else if (op === "redeploy") result = await chain.control.redeploy(token);
      else return sendJson(res, 400, { error: `unknown op: ${op}` });
      return sendJson(res, 200, { ...result, ...(await chain.control.status()) });
    }

    if (pathname === "/vendor/ethers.js") {
      const body = await readFile(ethersBundle);
      res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      return res.end(body);
    }

    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, safe === "/" ? "index.html" : safe);
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (req.method === "GET" && !pathname.startsWith("/api")) {
      const body = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" });
      return res.end(body);
    }
    sendJson(res, 500, { error: error?.message ?? String(error) });
  }
});

server.listen(port, () => console.log(`\nMandate demo (${liveMode ? "live RPC" : "local chain"}) at http://localhost:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await chain.close();
    process.exit(0);
  });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { IpLimiter } from "./faucet.mjs";

let child;
let base;

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// The real server on the in-process chain; the live-mode variables are dropped
// so this never talks to a network.
before(async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CONTROL_IP_PER_MINUTE: "2" };
  for (const name of ["DEMO_MNEMONIC", "MONAD_RPC_URL", "DEMO_ADMIN_TOKEN", "MANDATE_LIVE"]) delete env[name];
  child = spawn(process.execPath, ["web/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Mandate demo")) resolve();
    });
  });
});

after(() => child?.kill());

const post = (path, body) => fetch(base + path, { method: "POST", body, headers: { "content-type": "application/json" } });

test("malformed JSON is a 400 that says nothing about the server", async () => {
  for (const path of ["/rpc", "/api/faucet", "/api/batch/intent"]) {
    const response = await post(path, "{not json");
    assert.equal(response.status, 400, path);
    const { error } = await response.json();
    assert.equal(error, "request body is not valid JSON");
  }
});

test("a body that is not a JSON object is a 400, not a crash", async () => {
  assert.equal((await post("/api/faucet", "null")).status, 400);
});

test("an oversize body is a 413", async () => {
  const response = await post("/api/faucet", "x".repeat(2_100_000)).catch(() => null);
  // The server closes the socket after answering; a client that is still
  // sending may see the reset instead of the status.
  if (response) assert.equal(response.status, 413);
});

test("only the files the page loads are served", async () => {
  for (const path of ["/server.mjs", "/chain.mjs", "/deployments/31337.json", "/%2e%2e/package.json", "/nope"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + "/%zz")).status, 400);
  for (const path of ["/", "/index.html", "/app.js", "/styles.css", "/vendor/ethers.js", "/api/deployment"]) {
    assert.equal((await fetch(base + path)).status, 200, path);
  }
});

test("every response carries the security headers; HTML also a CSP", async () => {
  for (const path of ["/", "/app.js", "/nope"]) {
    const { headers } = await fetch(base + path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
  }
  const csp = (await fetch(base + "/")).headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal((await fetch(base + "/app.js")).headers.get("content-security-policy"), null);
});

test("POST /api/control is limited per client with a retry-after", async () => {
  const send = () => post("/api/control", JSON.stringify({ op: "restorePrice" }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const refused = await send();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
});

test("IpLimiter refills, keeps clients apart and stays bounded", () => {
  let now = 0;
  const limiter = new IpLimiter(2, { maxClients: 3, now: () => now });
  assert.equal(limiter.take("a"), 0);
  assert.equal(limiter.take("a"), 0);
  assert.ok(limiter.take("a") >= 1);
  assert.equal(limiter.take("b"), 0);
  now = 30_000; // one token back at 2 per minute
  assert.equal(limiter.take("a"), 0);
  for (const ip of ["c", "d", "e", "f"]) limiter.take(ip);
  assert.ok(limiter.buckets.size <= 3);
});

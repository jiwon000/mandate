import assert from "node:assert/strict";
import { test } from "node:test";
import { FaucetLimiter, clientIp } from "./faucet.mjs";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const D = "0x00000000000000000000000000000000000000d4";

test("one drip per address per window, whatever the IP", () => {
  let now = 0;
  const limiter = new FaucetLimiter({ windowMs: 1000, perIp: 10, now: () => now });
  limiter.take(A, "1.1.1.1");
  assert.throws(() => limiter.take(A, "2.2.2.2"), /already received/);
  assert.throws(() => limiter.take(A.toUpperCase().replace("0X", "0x"), "3.3.3.3"), /already received/);
  now = 1000;
  limiter.take(A, "2.2.2.2");
});

test("a few drips per IP per window, so rotating addresses does not drain it", () => {
  let now = 0;
  const limiter = new FaucetLimiter({ windowMs: 1000, perIp: 2, now: () => now });
  limiter.take(A, "ip");
  limiter.take(B, "ip");
  assert.throws(() => limiter.take(C, "ip"), (error) => error.httpStatus === 429 && /used its 2 drips/.test(error.message));
  limiter.take(C, "other");
  now = 999;
  assert.throws(() => limiter.take(D, "ip"), /used its 2 drips/);
  now = 1000;
  limiter.take(D, "ip");
});

test("a failed drip gives the slot back", () => {
  const limiter = new FaucetLimiter({ perIp: 1 });
  limiter.take(A, "ip");
  limiter.release(A, "ip");
  limiter.take(A, "ip");
});

test("refuses anything that is not an address", () => {
  const limiter = new FaucetLimiter();
  assert.throws(() => limiter.take("0x1234", "ip"), (error) => error.httpStatus === 400);
  assert.throws(() => limiter.take(undefined, "ip"), (error) => error.httpStatus === 400);
});

test("clientIp takes the hop the host's proxy appended, not one the client wrote", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 9.9.9.9" }, socket: { remoteAddress: "10.0.0.2" } }), "9.9.9.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.2" } }), "10.0.0.2");
});

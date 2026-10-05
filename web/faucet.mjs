// Test-token faucet limits, shared by the local chain and the live server.
//
// The faucet mints mock USDC, which costs the owner gas on a live chain, and
// may also send native gas when the operator sets FAUCET_NATIVE_WEI. Both
// are bounded here: one drip per address per window, and a few per client IP
// per window, so one visitor cannot drain the deployer by rotating addresses.
import { isAddress } from "ethers";
import { USDC } from "./mandates.mjs";

export const FAUCET_USDC = USDC(10_000);
export const FAUCET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FAUCET_PER_IP = 3;

export class FaucetError extends Error {
  constructor(message, httpStatus = 429) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export class FaucetLimiter {
  constructor({ windowMs = FAUCET_WINDOW_MS, perIp = FAUCET_PER_IP, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.perIp = perIp;
    this.now = now;
    this.byAddress = new Map(); // address -> last drip time
    this.byIp = new Map(); // ip -> drip times inside the window
  }

  // Throws a FaucetError when the drip is refused; records it otherwise. The
  // caller takes the slot before sending, so two concurrent requests for one
  // address cannot both pass.
  take(address, ip = "unknown") {
    if (!isAddress(String(address ?? ""))) throw new FaucetError("not an address", 400);
    const key = String(address).toLowerCase();
    const now = this.now();
    this.prune(now);
    const last = this.byAddress.get(key);
    if (last !== undefined) {
      const wait = Math.ceil((last + this.windowMs - now) / 60_000);
      throw new FaucetError(`this address already received test tokens; try again in ${wait} min`);
    }
    const times = this.byIp.get(ip) ?? [];
    if (times.length >= this.perIp) {
      const wait = Math.ceil((times[0] + this.windowMs - now) / 60_000);
      throw new FaucetError(`this connection has used its ${this.perIp} drips; try again in ${wait} min`);
    }
    this.byAddress.set(key, now);
    times.push(now);
    this.byIp.set(ip, times);
  }

  // Gives a slot back when the drip itself failed, so a chain error does not
  // cost the visitor their allowance.
  release(address, ip = "unknown") {
    const key = String(address).toLowerCase();
    this.byAddress.delete(key);
    const times = this.byIp.get(ip);
    if (times?.length) times.pop();
  }

  prune(now) {
    for (const [key, at] of this.byAddress) if (now - at >= this.windowMs) this.byAddress.delete(key);
    for (const [ip, times] of this.byIp) {
      const kept = times.filter((at) => now - at < this.windowMs);
      if (kept.length) this.byIp.set(ip, kept);
      else this.byIp.delete(ip);
    }
  }
}

// The client address behind the one proxy a host such as Render puts in front
// of the server. That proxy appends the address it saw, so the last hop is the
// one a client cannot write; anything before it may be forged.
export function clientIp(req) {
  const hops = String(req.headers?.["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) || req.socket?.remoteAddress || "unknown";
}

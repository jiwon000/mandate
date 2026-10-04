// Gas arithmetic and send ordering for the live demo. No I/O here; web/live.mjs does that.

// The limit to sign with, given an estimate. Monad bills the limit rather than
// the gas used, so the bare estimate would be the cheapest choice, but an
// estimate is taken against one block and the transaction lands in a later one.
// If the oracle marks in between, poke() and execute() fold the new mark into
// the volatility estimate, and a poke that now finds a breach freezes the vault
// as well. Measured on Monad testnet: 203,474 estimated, 208,260 needed two
// blocks later, and a freezing poke at 220,609 against 158,501 for a quiet one.
// Signed with the bare estimate, such a transaction runs out of gas, is billed
// in full and changes nothing.
export function gasLimitFor(estimate, headroomPercent, cap) {
  const padded = (BigInt(estimate) * BigInt(100 + headroomPercent) + 99n) / 100n;
  return padded > BigInt(cap) ? BigInt(cap) : padded;
}

// Which demo accounts the deployer refills: only those under `floor`, each back
// up to `target`, emptiest first, and never more than `available` in total. An
// account is filled completely or not at all, so a nearly spent allowance does
// not dribble out in transfers that each cost gas themselves.
export function planTopUps(accounts, { floor, target, available }) {
  const plan = [];
  let left = available;
  const low = accounts
    .filter((account) => account.balance < floor)
    .sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));
  for (const account of low) {
    const value = target - account.balance;
    if (value > left) continue;
    plan.push({ address: account.address, value });
    left -= value;
  }
  return plan;
}

// How much may still be spent, counting what was spent in the last `windowMs`.
export class RollingBudget {
  constructor(limit, windowMs, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = [];
  }
  left() {
    const cutoff = this.now() - this.windowMs;
    this.entries = this.entries.filter((entry) => entry.at > cutoff);
    const spent = this.entries.reduce((sum, entry) => sum + entry.amount, 0n);
    return spent >= this.limit ? 0n : this.limit - spent;
  }
  spend(amount) {
    this.entries.push({ at: this.now(), amount });
  }
}

// Runs the tasks that share a key one at a time, in arrival order, whatever the
// outcome of the one before. Tasks under different keys do not wait for each other.
export function perKeyQueue() {
  const tails = new WeakMap();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    tails.set(key, run.then(() => {}, () => {}));
    return run;
  };
}

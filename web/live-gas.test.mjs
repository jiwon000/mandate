import test from "node:test";
import assert from "node:assert/strict";
import { RollingBudget, gasLimitFor, perKeyQueue, planTopUps } from "./live-gas.mjs";

test("the signed limit covers a poke that turns into a freeze after the estimate", () => {
  // Testnet figures: a quiet poke estimates 158,501; the same call freezing needs 220,609.
  assert.ok(gasLimitFor(158_501n, 50, 1_500_000) >= 220_609n);
  // And the case that failed in rehearsal: 203,474 estimated, 208,260 needed.
  assert.ok(gasLimitFor(203_474n, 50, 1_500_000) >= 208_260n);
});

test("headroom rounds up, takes numbers or bigints, and never passes the cap", () => {
  assert.equal(gasLimitFor(101n, 50, 1_500_000), 152n);
  assert.equal(gasLimitFor(100, 0, 1_500_000), 100n);
  assert.equal(gasLimitFor(1_200_000n, 50, 1_500_000), 1_500_000n);
});

const account = (address, balance) => ({ address, balance });

test("only accounts under the floor are refilled, each up to the target", () => {
  const plan = planTopUps(
    [account("a", 300n), account("b", 99n), account("c", 100n), account("d", 0n)],
    { floor: 100n, target: 300n, available: 10_000n }
  );
  assert.deepEqual(plan, [{ address: "d", value: 300n }, { address: "b", value: 201n }]);
});

test("the emptiest account goes first and the plan never exceeds what is available", () => {
  const plan = planTopUps(
    [account("a", 50n), account("b", 10n), account("c", 20n)],
    { floor: 100n, target: 300n, available: 600n }
  );
  // b (290) and c (280) fit in 600; a (250) no longer does.
  assert.deepEqual(plan, [{ address: "b", value: 290n }, { address: "c", value: 280n }]);
  assert.ok(plan.reduce((sum, p) => sum + p.value, 0n) <= 600n);
});

test("an account that cannot be filled completely is skipped, a smaller one behind it is not", () => {
  const plan = planTopUps(
    [account("a", 0n), account("b", 90n)],
    { floor: 100n, target: 300n, available: 250n }
  );
  assert.deepEqual(plan, [{ address: "b", value: 210n }]);
  assert.deepEqual(planTopUps([account("a", 0n)], { floor: 100n, target: 300n, available: 0n }), []);
});

test("a rolling budget frees what was spent once the window has passed", () => {
  let now = 0;
  const budget = new RollingBudget(100n, 1000, () => now);
  assert.equal(budget.left(), 100n);
  budget.spend(60n);
  now = 500;
  budget.spend(50n);
  assert.equal(budget.left(), 0n); // overspent reads as nothing left, not a negative
  now = 1001;
  assert.equal(budget.left(), 50n);
  now = 1501;
  assert.equal(budget.left(), 100n);
});

test("sends from one account never overlap, and a failed one does not block the next", async () => {
  const inOrder = perKeyQueue();
  const keeper = {}, agent = {};
  const events = [];
  const task = (name, ms, fail = false) => async () => {
    events.push(`${name} start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push(`${name} end`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
  const first = inOrder(keeper, task("k1", 30, true));
  const second = inOrder(keeper, task("k2", 5));
  const other = inOrder(agent, task("a1", 5));
  await assert.rejects(first, /k1 failed/);
  assert.equal(await second, "k2");
  assert.equal(await other, "a1");
  // Same account: k2 waits for k1 although k1 is slower and fails.
  assert.ok(events.indexOf("k1 end") < events.indexOf("k2 start"));
  // Another account does not wait for the keeper's queue.
  assert.ok(events.indexOf("a1 end") < events.indexOf("k1 end"));
});

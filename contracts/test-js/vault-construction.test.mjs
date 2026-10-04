import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixture.mjs";

// Security-review finding (2026-10-04, Slither missing-zero-check): agent_ is
// only ever compared with `==` in execute(), never called, so a zero value
// would not revert anywhere -- it would silently deploy a vault no one can
// ever trade from. The other constructor args are contract-typed and fail
// loud on first real use, so only agent_ needed an explicit guard.
test("MandateVault refuses to deploy with a zero agent address", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.deploy("MandateVault", "MandateVault", [
      await f.usdc.getAddress(),
      await f.guard.getAddress(),
      "0x0000000000000000000000000000000000000000",
      f.adapterAddress
    ]),
    /ZeroAgent|revert/
  );
});

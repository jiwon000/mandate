# Security review — 2026-10-04

This is an internal review, not an external audit. Slither (static analysis)
plus a manual triage of every finding, and a separate skill-driven review
pass against the PR diff. It exists to catch obvious issues before an actual
third-party audit, not to replace one.

## Tooling

```
pip3 install slither-analyzer solc-select   # needed a local Rust toolchain
                                             # for cbor2's build; see rustup.rs
solc-select install 0.8.37 && solc-select use 0.8.37
slither contracts/src --exclude-dependencies
```

Slither auto-detects this as a Foundry project (via `foundry.toml`) and
shells out to `forge build`, so it compiles with the same `via_ir`,
remappings and solc version the test suite uses. 37 contracts, 102
detectors, 45 results: 2 High, 26 Medium, 13 Low, 4 Informational.

## Fixed

Two findings were real and safely fixable without changing any documented
behavior (`contracts/src/MandateVault.sol`):

1. **`missing-zero-check` on `agent_`.** The constructor's other three
   arguments (`asset_`, `riskGuard_`, `adapter_`) are contract-typed and fail
   loud the first time a real method is called on them. `agent_` is only
   ever compared with `==` inside `execute()`, so a zero value would not
   revert anywhere — it would silently deploy a vault nobody could ever
   trade from. Added `if (agent_ == address(0)) revert ZeroAgent();`.
2. **`missing-inheritance`: `MandateVault` should declare `IMandateVaultFreeze`.**
   It already implements `freeze(address) returns (uint256)` structurally —
   `MandateRiskGuard` calls it through an `IMandateVaultFreeze(vault)` cast —
   but never declared conformance, so a future signature mismatch between
   the two files would only surface as a runtime revert, not a compile
   error. Added the interface to the `is` list.

Both are covered by `contracts/test-js/vault-construction.test.mjs` (the
zero-agent revert) and the existing test suite (the interface declaration
changes no behavior; all 58 Hardhat + 5 Foundry suites still pass).

## Reviewed and accepted (false positives or benign, with reasoning)

**`incorrect-equality` (5 instances)** — `supply == 0`, `shares == 0`,
`assets == 0` (`MandateVault`), `usage.blockNumber == block.number`
(`MandateRiskGuard`), `lastUnwindBlock == block.number` (`MandateVault`).
Slither's detector exists for the classic "attacker dusts a balance to dodge
an exact-match check" bug. None of these are that: they are zero-value
guards and same-block checks, where `block.number` is monotonic within a
transaction and cannot be made to equal a stale value by anyone. Exact
equality is the *correct* operator here, not a bug.

**`uninitialized-local` (9 instances)** — loop accumulators (`cursor`,
`assets`, `assigned`, `cumulativeAssets`, `count`, `next` in
`BatchAllocator`; `locked`, `closedNotional`, `realizedPnl` in
`MandateVault`). Solidity zero-initializes locals by default, which is
exactly the starting value every one of these wants. Standard false-positive
category for this idiom.

**`unused-return` (7 instances)** — e.g. `ECDSA.tryRecover`'s third return
(`errorArg`, only useful for a more detailed revert message; the code
already reverts generically on any `error != NoError`), `IVenueAdapter`
calls where only one of two returned values is needed at that call site
(the mock venue's single-market design makes `positionNotional` and
`totalNotional` equal, so call sites that only need one of them correctly
ignore the other). Checked each one individually for a case where the
ignored value gated a security-relevant decision; none did.

**`reentrancy-balance` (2 instances, High impact)** — `BatchAllocator._allocate()`
reads `beforeShares`/`beforeAssets` *before* `vault.allocate()`, then compares
the vault's and asset's balances *read again after the call* against those
baselines. Slither's heuristic flags any "read balance → external call →
balance-derived condition" shape, but the post-call reads here are fresh,
not stale — this is the documented defensive pattern
(`docs/batch-allocator-milestone2.md`: "checks the actual token debit and
share balance increase against the vault's returned result"), the same shape
`depositEscrow()` already uses for fee-on-transfer-token defense. Confirmed
by hand that no local variable is reused in place of a fresh read.

**`reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events`** — state
writes or event emissions after an external call in `BatchAllocator` and
`MandateRiskGuard._markAndCheck`. Checked whether any *other* function
reachable during that external call both lacks `nonReentrant` and reads/writes
the same state in a way that matters: `BatchAllocator.cancelIntent()` is the
only non-`nonReentrant` entry point that touches overlapping state
(`nonceUsed`), but a vault reentering during `vault.allocate()` can only act
as itself, not the original allocator, so it cannot cancel the allocator's
nonce. Vaults are an explicitly documented trusted integration boundary
("Use only reviewed, non-upgradeable Mandate vaults" — milestone doc), so a
malicious vault is out of this scope's threat model regardless.

**`divide-before-multiply` (`MandateRiskGuard._stress()`)** — `sigmaBps`
truncates at `/1e14` before being multiplied again for `moveBps`, and again
for `lossBps`. Real, but the compounded rounding error is bounded by roughly
1e14 units out of inputs that are 1e16–1e18 scale (well under 1 bp of
relative error), against `maxDrawdownBps` limits in the hundreds-to-low-
thousands. The rounding direction (Solidity truncates toward zero) makes the
stress check *very slightly* less conservative, never more — but the
existing variance estimate itself carries far more uncertainty than this
truncation (see README's "k sigma assumes returns that are roughly normal"
caveat). Not worth restructuring a tested, safety-critical function for a
sub-basis-point effect; noted here instead of silently dismissed.

**`calls-loop` / `costly-loop`** — `BatchAllocator._allocate()`'s external
calls and SSTORE inside `settleEpoch()`'s loop are bounded by the existing
`MAX_INTENTS = 128` validation, and the milestone doc already discloses this
is "a validation bound, not a benchmarked Monad gas guarantee."

**`pragma`** — multiple Solidity version pragmas across the repo's own
`^0.8.24` files and OpenZeppelin's own `^0.8.20` / `>=0.6.2` / `>=0.4.16` /
`>=0.8.4` floors. Universal in any OZ-based project; the actually-compiled
version is the single pinned `solc_version = "0.8.37"` in `foundry.toml` /
`contracts/tools/compile.mjs`.

**`cyclomatic-complexity`** (`checkAndConsumeBefore`, complexity 14) — a
maintainability metric. The function is already covered by the Hardhat
suite and a dedicated Foundry invariant handler (`MandateHandler.sol`);
refactoring a tested, security-critical function purely to lower a
complexity score would risk introducing a new bug for no safety benefit.

## Second pass: `security-review` skill

A separate review against the full PR diff (`main..docs/roadmap-feedback-0923`),
using the project's own security-review skill: a fresh sub-agent re-reads
every touched file in full (not just diff hunks) and reports candidate
findings with its own confidence score, under instructions to apply both the
standard web-vulnerability categories and Solidity-specific classes
(reentrancy, access control, signature replay, economic manipulation,
precision exploits) and to exclude DoS/rate-limiting/test-only/doc-only
findings. Two related, high-confidence findings came back; both were real.

### Fixed: `registerAgent()` trusted a caller-supplied `guard` address (confidence 9/10)

**The bug.** The original implementation took `guard` as a parameter and
checked only that the `(guard, limits, adapter)` tuple was *internally*
self-consistent — by calling `termsLocked`, `termsHash` and `adapterAllowed`
back on that same caller-chosen address. It never asked the one party that
actually knows the truth: the vault itself.

**The exploit.** Deploy a trivial contract that unconditionally returns
`termsLocked(any) = true`, `termsHash(any) = keccak256(abi.encode(attackerLimits))`,
and `adapterAllowed(any, any) = true`. Call
`registerAgent(realVault, fakeGuard, attackerAdapter, attackerLimits, attackerFees, attackerModelHash)`.
Every internal check passes — the fake guard agrees with whatever the
attacker claims — and `agentOf[realVault]` is now permanently occupied
(`AlreadyRegistered` blocks every future call) with fabricated metadata, for
a vault the attacker never deployed, configured, or has any relationship to.
This directly falsified the contract's own doc comment ("there is nothing a
caller can lie about") and the commit message that introduced it. The
existing tests never caught it because they only ever passed the real guard
belonging to the fixture vault.

**The fix.** `registerAgent(vault, adapter, limits, fees, modelHash)` —
`guard` is no longer a parameter. It is read directly off the vault:
`IMandateVaultView(vault).riskGuard()`, added to the interface since
`MandateVault.riskGuard` was already a public immutable (same "just declare
the getter" pattern as `termsHash`/`adapterAllowed` in the 2026-10-04 Registry
work). `vault` is either a real, reviewed `MandateVault` or the call reverts
the first time anything is actually invoked on it — there is no longer a
parameter an attacker can point anywhere else.

### Fixed: `fees`/`modelHash` had no authorization boundary, enabling front-running (confidence 7/10)

**The gap.** `guard`, `limits` and `adapter` are all independently checkable
against on-chain ground truth, which is what makes permissionless
registration safe for them. `fees` (`FeeTerms`) and `modelHash` are not —
they are declared metadata with nothing to check against. Combined with
one-time-only registration and full permissionlessness, anyone who noticed a
`lockTerms()` transaction (or simply won a race) could call `registerAgent()`
first with the *correct* guard/limits/adapter but attacker-chosen fee terms
or model hash, permanently attaching fabricated metadata to a legitimate
vault's catalog entry with no way to correct it afterward.

**The fix.** `registerAgent()` now requires `msg.sender == Ownable(guard).owner()`
(`OnlyGuardOwner`) — the same operator already trusted to configure and lock
the vault's real risk terms in the first place, rather than an open call
anyone can win. This narrows the function from "permissionless" to
"the vault's own operator," which is the only grouping that has any basis to
assert fee/model metadata is true.

**Verification.** `contracts/test-js/registry.test.mjs` gained two tests:
`registerAgent reads the real guard off the vault and cannot be pointed at a
fake one` (confirms the stored `guard` is always `vault.riskGuard()`'s real
value) and `registerAgent is restricted to the vault's guard owner, not
permissionless` (confirms a non-owner call reverts `OnlyGuardOwner`). Full
suite re-run clean: 61 Hardhat + 5 Foundry test suites, `web/` demo
re-deploys and serves `/api/reporter/status` without error.

No other high-confidence findings came back from this pass. Explicitly
checked and ruled out: `unwind()`/`freeze()` bounty economics (matches
documented keeper-incentive sizing, no extraction path beyond the intended
1–5 bps of idle cash), `_stress()`/`_projectVol()` arithmetic (no
attacker-exploitable rounding gain; overflow would revert rather than
under-charge risk), the new `/api/batch/*` and `/api/reporter/*` HTTP routes
(relay-friendly by design — the underlying signature/contract-state checks
are the real authorization boundary and are intact), static file serving in
`web/server.mjs` (path traversal surface unchanged by this PR), and
`web/app.js`'s `innerHTML` sinks (only ever interpolate server-fixed config
strings or numeric/hash values, never attacker-controllable on-chain data).

## Round 2: adversarially re-checking the fix, and the same scrutiny on BatchAllocator

A fresh sub-agent (no memory of writing the fix) was asked to (a) try to find
a residual gap in the `registerAgent()` fix above, and (b) apply the exact
same "does this check X against a Y that was also caller-supplied" scrutiny
to `BatchAllocator.sol` — the only other contract in the repo that both
custodies real funds (USDC escrow) and relies on an EIP-712 signature over
caller-supplied data, the same risk shape as the bug that was just found.

**Job 1 verdict: the fix is sound.** `MandateVault.riskGuard` is `immutable`,
set once in the constructor with no setter and no delegatecall path, so a
real vault's `riskGuard()` cannot be redirected after deployment — the
original exploit (hijacking an existing vault's one-time registry slot) is
fully closed. Every check in `registerAgent()` ahead of the one state write
is a `STATICCALL` (all the interface functions involved are `view`), so there
is no reentrancy surface in the new read chain either. Two precision notes
came back, both low-severity and documentation-only:

- A caller can still deploy their *own* fake vault-plus-fake-guard pair and
  register it — but this only ever writes an entry keyed by an address they
  themselves control, never one belonging to a real vault, since a real
  vault's `riskGuard()` was fixed before the attacker could act. The doc
  comment's claim that `vault` is proven to be "the real, reviewed
  MandateVault" overstated this; fixed to say what is and isn't actually
  checked (registry commit, same date).
- `MandateRiskGuard` is multi-tenant — one guard instance is shared across
  every vault in a deployment (confirmed in `web/chain.mjs` and
  `batch-flow.test.mjs`). If that guard's `Ownable` ownership is transferred
  between a vault's `lockTerms()` and its `registerAgent()` call, the *new*
  owner — not whoever actually configured that specific vault — gets to
  assert its `fees`/`modelHash`. This needs a specific admin-level
  ownership-transfer timing window to matter and was scored 3/10; noted here
  rather than changed in code, since snapshotting an owner-at-lock-time would
  add real complexity for a narrow, already-centralized-by-design trust
  boundary (the guard's owner is the same operator this whole document
  already treats as trusted).

**Job 2 verdict: no new findings in `BatchAllocator.sol`.** Checked
specifically for the registerAgent-shaped bug (nothing found — `net.vault` is
validated against the owner-curated `vaultAllowed` allowlist and against each
intent's own signed `intent.vault` field, never against itself), EIP-712
signature/replay correctness (`ECDSA.tryRecover` surfaces malformed/malleable
signatures as a `RecoverError` rather than a spoofable `address(0)`, and
nonces cannot replay across epochs or vaults), Merkle root forgeability (leaves
are built only from already-signature-verified intents and the contract
recomputes the root itself), `claimShares()` accounting (entitlements are
keyed by the full signed-intent hash, which embeds the allocator, so one
allocator's claim cannot be redirected to another), and escrow accounting
(balance-delta checks match the documented fee-on-transfer defense, no path
found that desyncs `escrowOf`/`totalEscrow` from real balances beyond the
already-documented vault trust boundary).

## What this review does not substitute for

This is static analysis plus one LLM-driven pass, not an audit. It has no
view of economic/game-theoretic attacks beyond what was explicitly reasoned
through above, no formal verification, and no fuzzing beyond what
`contracts/test/` already covers (Vault/RiskGuard custody and state-machine
invariants, Registry's epsilon ledger — not `registerAgent()`'s access
control, which this review's finding shows was exactly where the real bug
was hiding). An external, independent audit is still a prerequisite before
any real-money deployment.

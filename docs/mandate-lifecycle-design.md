# Mandate lifecycle and terms: design

Status: decisions confirmed 2026-10-05; items 2 to 4 of the order of work are implemented, see "Implemented" below. Where a line says "today" it describes the code as of commit `2359347`, before that work. Items 5 to 9 are not implemented.

This note answers three questions together, because they share one answer: what makes a vault freeze, who sets the freeze threshold, and what happens after a freeze. It also sets the structure for adding more kinds of terms later.

## Principles

1. One vault is one mandate. Its terms are fixed when they are locked and a finished mandate is never reopened. Today `MandateRiskGuard.lockTerms()` and the terminal `Closed` state already follow this.
2. Enforcement is permissionless. Freezing, unwinding and recording an outcome can be done by anyone, so the guarantee survives the operator disappearing. Today `poke()` and `unwind()` follow this; registration and outcome recording do not.
3. An allocator's exit is never closed by a term or a state. Withdrawal does not pass through any term check.
4. The registrant sets the values and the protocol sets the rules. The protocol decides which kinds of terms exist, how each is measured and what range a value may take. It does not pick the values.

## 1. What freezes a vault

Today exactly one thing freezes a vault: drawdown of NAV per share from its high-water mark above `maxDrawdownBps`, checked by `poke()` and after every trade. Every other limit (order, position, total and per-block notional, leverage, cooldown, stress) makes the guard revert that order and nothing more.

Proposed rule: the kind of term decides the consequence. A registrant does not choose between "revert" and "freeze" per term.

| Class | What it covers | Consequence | Why |
|---|---|---|---|
| Pre-trade | Order size, position and total notional, leverage, cooldown, stress test, and later market allowlist, slippage cap, trades per day | The order reverts. No freeze. | The breach can be stopped before it happens, so nothing has gone wrong yet. |
| State | Drawdown from high-water, and later daily loss and maximum holding time | Anyone may freeze the vault. | Price moves can cross these with the agent doing nothing. They cannot be prevented, only detected. |
| Unobservable | No fresh mark for a set multiple of `maxMarkAgeSeconds` | Anyone may freeze the vault. | New. Today a stale mark makes `poke()` revert with `MarkTooOld`, so a vault whose price feed stops stays `Active` with nobody able to check it. If the guarantee cannot be verified, new risk should stop. |

One rule then covers every future term: a vault freezes when a state term breaks or when it can no longer be observed.

## 2. Who sets the threshold

Today `maxDrawdownBps` is already a per-vault term, not a protocol constant. Two gaps: a value of `0` turns the freeze off entirely, and nothing bounds either it or `maxMarkAgeSeconds`.

Proposed:

- Every mandate must carry a loss bound and a mark age. `maxDrawdownBps` and `maxMarkAgeSeconds` must both be non-zero, and `configure()` refuses terms that leave either at zero. A drawdown cap is only as tight as the age of the mark it is checked against, so one is meaningless without the other.
- The protocol fixes a range for each, per protocol version: recommended `maxDrawdownBps` in (0, 5000] and `maxMarkAgeSeconds` in (0, 60], see Open decisions. A different range means a new guard version, never an edit to a live one.
- Inside the range the registrant chooses, and the allocator reads the locked value before funding.

## 3. After a freeze

| Stage | Proposed behaviour | Today | Reason |
|---|---|---|---|
| Freeze | `execute()` and `allocate()` close; `withdraw()` and share transfers stay open; the caller who proved the breach is paid `POKE_BOUNTY_BPS` (0.05%). | Same. | |
| Unwind | Anyone calls `unwind()` once per block; five steps close the position in equal slices, each paying `UNWIND_BOUNTY_BPS` (0.01%); a call that finds the position already flat closes the vault and pays nothing. | Same. | The step count and pace are protocol constants for now. Revisit them against real slippage once the Perpl adapter exists. |
| Close | Position at zero moves the vault to `Closed`. Terminal. | Same. | Principle 1. |
| Funds | Each allocator withdraws their own share. No automatic payout. | Same. | A push to every allocator has unbounded gas and one failing receiver blocks all of them. A pull fails only for the one caller. |
| Fees | Management fee stops accruing at the freeze. Performance fee is charged only above the high-water mark, so a frozen vault accrues none. | Fees are declared in `FeeTerms` and never charged. | These rules are part of implementing fee deduction, not a separate patch. |
| Record | Anyone calls `recordOutcome(vault)` on the registry. The registry reads `state()` and the final mark from the vault itself and stores the outcome permanently. | The registry stores nothing about outcomes. | No trusted reporter is needed for a fact the chain already holds. Principle 2. |
| Return | The same agent may start again only as a new vault with newly locked terms. The registry lists every vault and outcome under the agent address (`vault.agent()`). Deposits are never moved to the new vault. | The registry is keyed by vault only. | Consent is given per set of terms, so money cannot follow the agent into terms its owners never read. |

No cooldown and no penalty on returning. The protocol records facts and allocators judge them. A penalty would need someone to set its size, which brings back the trust the design removes.

### Open tension: a stale mark blocks withdrawal

Today `withdraw()` calls `requireFreshMark` in every state except `Closed`. A frozen vault whose price feed stops therefore also blocks withdrawal, against principle 3. The check exists for a reason: pricing shares off an old mark lets whoever leaves first take value from whoever stays. Proposed direction, not settled: while a vault is unobservable, allow withdrawal of each holder's pro-rata share of the vault's cash only, leaving the claim on the open position in place until `unwind()` or a fresh mark resolves it. This needs its own review before implementation.

## 4. Adding more kinds of terms

Today all terms live in one fixed struct, `RiskLimits`. Every new kind of term means a new struct layout and a new guard.

Proposed structure for the long run:

- A term catalogue owned by the protocol. Each entry is a reviewed check module with a class (pre-trade or state), a unit, a measurement source and a value range.
- A registrant picks modules from the catalogue and fills in values. `termsHash` binds the list of module addresses and their values, so the terms an allocator reads remain the terms enforced.
- Only catalogued modules are accepted. A malicious module could pass every order or block withdrawals, so arbitrary modules are out.
- A cap on modules per vault keeps the gas of `execute()` and `poke()` bounded.
- Withdrawal never calls a module (principle 3).
- The current `RiskLimits` becomes the first catalogue set, "core v1", so existing vaults keep their meaning.

Registration moves with it. Today `configure()`, `lockTerms()` and `registerAgent()` require the guard owner. A factory replaces that: in one transaction it deploys the vault, sets its terms, locks them and registers it, and anyone may call it. The catalogue check and the range check take the place of the owner's approval. This is roadmap item 15 in the README.

## Order of work

Before the hackathon deadline, inside the current structure and kept afterwards:

1. This note.
2. Done. `configure()` requires non-zero `maxDrawdownBps` and `maxMarkAgeSeconds` within the version's range.
3. Done. Unobservable freeze: a permissionless call that freezes a vault whose mark is older than the set multiple of `maxMarkAgeSeconds`.
4. Done. `recordOutcome(vault)` on the registry, plus an index of vaults by agent (agent-linked, see below).

After the hackathon:

5. Term catalogue and modules, with `RiskLimits` as core v1.
6. Factory and permissionless registration (roadmap 15).
7. Fee deduction with the freeze rules above.
8. Perpl adapter (roadmap 16), then revisit the unwind schedule against real fills. Whether Perpl can liquidate a vault's position on its own, and how that interacts with `unwind()`, is not yet checked.
9. The stale-mark withdrawal rule from the open tension above.

## Implemented

Items 2 to 4, on the current contracts. They take effect on the next deployment; the hosted demo keeps running the contracts it was deployed with until it is redeployed.

- `MandateRiskGuard.configure()` reverts `InvalidLossTerms` unless `maxDrawdownBps` is in (0, `MAX_DRAWDOWN_BPS_CAP` = 5000] and `maxMarkAgeSeconds` is in (0, `MAX_MARK_AGE_CAP` = 60]. The check runs after the lock check, so locked terms still revert `LimitsLocked`.
- `MandateRiskGuard.freezeUnobservable(vault)`: anyone may call it once the vault's own mark (`markedAssets()`) is older than `UNOBSERVABLE_MARK_AGES` (3) times `maxMarkAgeSeconds`. It pays the same bounty as a drawdown freeze and emits `Unobservable`. It reverts `StillObservable` before that point and `NothingToProtect` for a vault with no shares, so a vault cannot be frozen between deployment and its first deposit. The guard records why and when it froze each vault in `freezeOf(vault)`: reason 1 drawdown, 2 unobservable.
- `MandateRegistry.recordOutcome(vault)`: anyone may call it for a registered vault that is Frozen or Closed. It reads `state()` from the vault and `freezeOf()` from the vault's guard and stores state, reason, freeze time and record time in `outcomeOf(vault)`. It only moves forward (Frozen, then Closed), and the freeze reason is kept after the vault closes. It does not store the final mark; the freeze event already carries it.
- Index by agent: `linkVault(vault)` lists a registered vault under its agent's address, read with `vaultsOf(agent)`. This differs from section 3, which had the registry index every vault by `vault.agent()` automatically. Only the vault's own agent may link. Registration is done by the guard owner, and an automatic index on `vault.agent()` would let anyone deploy a vault naming someone else's address and attach a bad outcome to it. The cost: an agent can choose not to link a vault. An allocator should treat an unlinked vault as one with no history, and the factory (item 6) can link at deployment once the agent signs it.

Tests: `contracts/test-js/lifecycle.test.mjs`. The Foundry invariant handler also calls `freezeUnobservable`; it is type-checked locally and runs in CI.

## Decisions

Confirmed by the team on 2026-10-05.

1. Vaults without a freeze (`maxDrawdownBps = 0`) are forbidden. A vault with no loss bound offers nothing a plain vault does not, and the product is the bound.
2. No restriction on an agent returning after a freeze, beyond starting a new vault, for the reason in section 3.
3. The ranges, with the demo's four mandates (`web/mandates.mjs`) as the check that real terms fit inside:

| Value | Range | Demo mandates today | Reason |
|---|---|---|---|
| `maxDrawdownBps` | above 0, at most 5000 (50%) | 300, 800, 1200, 2000 | Past half the capital a cap no longer reads as a loss bound. No floor: a tight cap is the registrant's choice and the allocator sees it before funding. |
| `maxMarkAgeSeconds` | above 0, at most 60 | 4, 30, 30, 60 | The guarantee is a cap checked against a recent price. Perpl's index price updates every 1 to 5 seconds, so 60 leaves room for slow markets without turning the check into a minute-scale one. |
| Unobservable after | 3 x `maxMarkAgeSeconds` | 12 to 180 seconds | One missed update is noise; three in a row means the feed is not arriving. A fixed multiple keeps the rule proportional to what the registrant promised. |

One consequence for the hosted demo, decided 2026-10-05 (keep the idle interval; accept that an idle vault can be frozen and reset): its oracle marks every 5 seconds while someone is watching and, when nobody is, every `ORACLE_IDLE_SECONDS` (300 by default, 3600 on the hosted demo since 2026-10-05). Once the demo is redeployed on these contracts, anyone could freeze an idle demo vault a few minutes after the last visitor leaves; the demo server itself never calls `freezeUnobservable`. With the Perpl adapter the venue keeps its own index fresh and this goes away. Marking within the shortest window (30 seconds for the live demo's 10-second mandate) whether or not anyone is watching would cost about 16 MON a day, so the demo keeps its idle interval and lets the existing auto-redeploy reset any vault frozen this way.

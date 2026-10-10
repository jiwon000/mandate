# Threat model and failure modes

What each part of Mandate can do wrong, what stops it, and what is left. The README's "Honest limitations" has the longer reasoning; this page is the table view of the same facts.

## Threats

| Who or what | What they could try | What stops it | Residual risk |
|---|---|---|---|
| Agent | Withdraw or move vault money directly | The agent role can only call `execute()` through the vault's one adapter; it never holds withdrawal authority | None in the contracts |
| Agent | Trade past the mandate (size, leverage, market, direction, cadence) | `MandateRiskGuard` checks the order before any external call and reverts it | Losses inside the mandate are allowed by design |
| Agent | Take a far-off fill against its own resting order (self-dealing on an order book) | Guard `maxPriceDeviationBps` when the mandate sets it. On Perpl, the adapter's own `maxAdverseLimitBps` band for every vault ([PR #19](https://github.com/jiwon000/mandate/pull/19); the testnet adapter is deployed with 300 bps) | Inside the band an agent can still trade against itself. The mock venue fills at its mark, so the hosted demo is not exposed |
| Agent | Run the vault into a loss and walk away | `poke()` freezes past `maxDrawdownBps`, daily loss or holding time; anyone can call `unwind()` | Realised loss can exceed the term by slippage and gaps; `unwind()` is bounded to 1% of the venue mark per step |
| Vault owner | Change terms after money arrives | `lockTerms()` is one-way and `allocate()` reverts before it; `termsHash` covers all nineteen terms, twenty-one with the reference-price bound | None. An owner can also never lock, and then nobody can deposit |
| Price source | Report a wrong or stale mark | Mark age term (`maxMarkAgeSeconds` up to 60) on trades, `poke()` and withdrawals. On Perpl, the optional reference-price bound refuses new exposure while the mark sits more than `maxMarkDeviationBps` from Perpl's oracle price or that price is stale | Without the reference bound, a fresh but wrong price is accepted; with it, a wrong mark still passes if it stays inside the bound, and exits are not checked against it. Taking a position through flat counts as new exposure, so a flip is checked too. On testnet the mark is the deployer's keeper script, so it is only as honest as that keeper |
| Price source | Stop reporting entirely | `freezeUnobservable()` after three mark ages, then `withdrawUnpriced()` pays the cash share | The open position's share stays with those who remain until a mark returns |
| Keeper / caller of `poke()` and `unwind()` | Drain the vault through bounties | Bounties are fixed (0.05% per freeze, 0.01% per unwind step, one step per block); the freeze bounty is paid only when the call freezes | A breach costs allocators the bounties on top of the drawdown |
| Batcher (team server) | Misallocate or hold escrow | Allocations need the allocator's EIP-712 signature; unspent escrow can be withdrawn at any time with `withdrawEscrow()`; the batcher cannot withdraw vault funds | It can leave an intent out of a batch; the allocator then withdraws the escrow and deposits directly. A vault that refuses its deposit is skipped and its intents refunded to escrow (since 2026-10-10); the testnet BatchAllocator predates this, and there a stale or frozen vault reverts the whole epoch |
| DP reporter | Publish a false leaderboard or overspend ε | Signed digest, ε ledger checked on chain by `MandateRegistry` | The chain cannot check that noise was added. The ε guarantee is exact for the mean only and per tick return (a vault with k returns is covered at k·ε); Sharpe and drawdown figures are indicative. DP does not hide public transactions |
| Demo proxy (hosted site) | Abuse the server's testnet keys | Per-role function allowlist, no value transfers, gas cap, global rate limit, operator-only reset | Anyone with the URL spends the operator's testnet gas. It is a demo convenience, not a custody model |
| Venue | Refuse orders, fill in part, hold back withdrawals | Fill-or-kill on trades with a post-trade position check; unwind skips a refusing market and retries; held-back money stays in equity and `sweep()` returns it | Perpl's own liquidation is not modelled. While Perpl's mark is stale it refuses orders, so only the cash-only exit works |

## When each part fails

| Part | If it fails, what is lost | What still works |
|---|---|---|
| Agent (offline or broken) | New trades | Withdrawals at the mark, `poke()`, `unwind()` after a freeze |
| Oracle / keeper script | Fresh marks, so trades and priced withdrawals stop | After three mark ages: freeze and `withdrawUnpriced()` for the cash share |
| Keepers (nobody calls `poke()`) | Timely freezes; a breach can grow until someone calls | Every trade re-marks and checks drawdown; any address can call `poke()` and is paid for it |
| Batcher | Epoch netting and new allocations through `BatchAllocator` | `withdrawEscrow()` at any time; direct deposits; existing shares and withdrawals |
| DP reporter | New leaderboard releases | Vaults, trading and withdrawals do not depend on it |
| Demo proxy / hosted site | The browser demo | The contracts and addresses on Monad testnet, callable from any wallet |
| Venue (Perpl) | Trading and unwinding on that market | The other markets keep unwinding; held collateral stays in equity; cash-only exit |
| Mandate contracts | Everything above. There is no upgrade path and no external audit | Nothing; a fix is a new deployment |

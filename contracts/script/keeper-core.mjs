// One keeper tick, free of any venue or oracle: look at each vault and send a
// transaction only when it earns something.
//
//   Active  -> poke() when a view says the drawdown or holding-time term is
//              breached at the current mark; freezeUnobservable() when the mark is
//              older than UNOBSERVABLE_MARK_AGES * maxMarkAgeSeconds. A daily loss
//              only pauses new risk and pays nothing, so it is not poked for.
//   Frozen  -> resume() if the guard would allow it (an unobservable freeze whose
//              mark is back inside the recovery window); otherwise unwind(), one
//              step per call, once the window has passed.
//   Closed  -> nothing.
//
// Both bounties are paid to the caller, so poke and unwind are the keeper's income;
// resume pays nothing and is sent because it keeps a healthy vault from being
// unwound. The views and staticCalls are free. `mode` picks what an Active vault gets:
//   "check"   (default) poke only when it would freeze.
//   "mark"    also poke a healthy vault every tick, which keeps the high-water mark
//             and the daily-loss base current (the mock-venue keeper does this).
//   "observe" call observe() instead of poke(), no freeze.
const ACTIVE = 0n;
const FROZEN = 1n;

const reason = (error) => error.shortMessage ?? error.message;

async function send(call, action) {
  const receipt = await (await call).wait();
  return { ...action, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/// Why poke() would freeze `vault` at the current mark, or null. Mirrors
/// MandateRiskGuard._markAndCheck from the guard's own views.
async function breachOf(guard, vault, adapter, now) {
  const limits = await guard.limitsOf(vault);
  const [, , drawdownBps] = await guard.quote(vault, adapter);
  if (drawdownBps > limits.maxDrawdownBps) return `drawdown ${drawdownBps}bps > ${limits.maxDrawdownBps}`;
  const terms = await guard.tradeTermsOf(vault);
  const openedAt = await guard.positionOpenedAt(vault);
  if (terms.maxHoldingSeconds !== 0n && openedAt !== 0n && now > openedAt + terms.maxHoldingSeconds) {
    return `held ${now - openedAt}s > ${terms.maxHoldingSeconds}`;
  }
  return null;
}

async function serveActive({ guard, vault, adapter, now, mode }) {
  const base = { vault: vault.address, name: vault.name };
  // A mark nobody can refresh any more: freeze before the position goes unchecked.
  // The staticCall is the whole test (it reverts StillObservable, NothingToProtect, ...).
  let unobservable = false;
  try {
    await guard.freezeUnobservable.staticCall(vault.address);
    unobservable = true;
  } catch { /* still observable, or nothing to protect */ }
  if (unobservable) {
    try {
      return await send(guard.freezeUnobservable(vault.address), { ...base, action: "freezeUnobservable" });
    } catch (error) {
      return { ...base, action: "skip", reason: `freezeUnobservable: ${reason(error)}` };
    }
  }

  if (mode === "observe") {
    try {
      return await send(guard.observe(vault.address, adapter), { ...base, action: "observe" });
    } catch (error) {
      return { ...base, action: "skip", reason: `observe: ${reason(error)}` };
    }
  }

  let breach = null;
  try {
    breach = await breachOf(guard, vault.address, adapter, now);
  } catch (error) {
    return { ...base, action: "skip", reason: `view: ${reason(error)}` };
  }
  if (!breach && mode !== "mark") return { ...base, action: "none", reason: "within limits" };

  try {
    // poke() reverts on a mark too old to check; no point paying for that.
    const wouldFreeze = await guard.poke.staticCall(vault.address, adapter);
    if (breach && !wouldFreeze) return { ...base, action: "skip", reason: `${breach}, but poke would not freeze` };
    return await send(guard.poke(vault.address, adapter), {
      ...base, action: "poke", froze: wouldFreeze, reason: breach ?? "mark"
    });
  } catch (error) {
    return { ...base, action: "skip", reason: `poke: ${reason(error)}` };
  }
}

/// @param guard   MandateRiskGuard contract connected to the keeper's signer.
/// @param vaults  [{ address, name, contract }], contract = read-only MandateVault.
/// @param signer  the keeper's signer: its provider gives the block time, and it
///                sends unwind().
/// @returns       one action per vault: { vault, name, action, ... }, action being
///                poke | freezeUnobservable | observe | resume | unwind | none | skip.
/// @param unwind  false leaves Frozen vaults alone (the mock-venue keeper never did).
export async function keeperTick({ guard, vaults, signer, mode = "check", unwind = true }) {
  const now = BigInt((await signer.provider.getBlock("latest")).timestamp);
  const actions = [];
  for (const vault of vaults) {
    const base = { vault: vault.address, name: vault.name };
    try {
      const state = await vault.contract.state();
      if (state === ACTIVE) {
        const adapter = await vault.contract.venueAdapter();
        actions.push(await serveActive({ guard, vault, adapter, now, mode }));
      } else if (state === FROZEN && unwind) {
        let resumable = false;
        try {
          await guard.resume.staticCall(vault.address);
          resumable = true;
        } catch { /* not an unobservable freeze, or a limit still breached */ }
        if (resumable) {
          actions.push(await send(guard.resume(vault.address), { ...base, action: "resume" }));
          continue;
        }
        const writer = vault.contract.connect(signer);
        try {
          await writer.unwind.staticCall();
          actions.push(await send(writer.unwind(), { ...base, action: "unwind" }));
        } catch (error) {
          // The one-per-block cooldown, or someone else's unwind landed first.
          actions.push({ ...base, action: "skip", reason: `unwind: ${reason(error)}` });
        }
      } else {
        actions.push({ ...base, action: "none", reason: state === FROZEN ? "frozen, unwind off" : "closed" });
      }
    } catch (error) {
      actions.push({ ...base, action: "skip", reason: reason(error) });
    }
  }
  return actions;
}

export function describeActions(actions) {
  return actions
    .map((a) => `${a.name}: ${a.action}${a.reason ? ` (${a.reason})` : ""}${a.txHash ? ` ${a.txHash.slice(0, 10)}` : ""}`)
    .join(" | ");
}

/// Every vault a MandateFactory has made, paged.
export async function factoryVaults(factory, page = 100n) {
  const total = await factory.vaultCount();
  const found = [];
  for (let start = 0n; start < total; start += page) found.push(...(await factory.vaultsFrom(start, page)));
  return found;
}

// Every number rendered here is read back from a contract on the chain this page
// is served from. There is no local copy of the state and no precomputed data:
// if a call reverts, the UI shows the error the guard actually raised.
const { ethers } = window;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const ONE = 10n ** 18n;
const ASSET_TO_E18 = 10n ** 12n;

const state = {
  deployment: null,
  provider: null,
  contracts: null,
  errorInterface: null,
  eventInterfaces: [],
  selected: 0,
  snapshot: [],
  price: 0n,
  chainTime: 0,
  blockNumber: 0,
  blockTimeSeconds: 1,
  wallet: null,
  // "injected" when a browser wallet signs, "demo" when the server's demo
  // allocator does (local chain, or the hosted demo's keys).
  walletKind: null,
  injected: null,
  factoryCount: 0,
  marketPrices: [],
  navSeries: new Map(),
  feed: [],
  lastScannedBlock: 0,
  busy: false,
  batch: { status: null, escrow: 0n, claims: [] },
  privacy: { status: null, onchainDigest: null },
  // Live mode: the chain is a real network, the server signs for the demo
  // accounts, and the oracle paces itself to whether anyone is watching.
  live: false,
  network: null,
  oracle: null,
  gas: null,
  adminToken: takeAdminToken()
};

// The admin token arrives as #admin=<token>, which never reaches a server or its logs,
// or the older ?admin=<token>. Either way it leaves the address bar at once and is kept
// for this tab only, so a reload stays signed in and a shared link carries nothing.
function takeAdminToken() {
  const search = new URLSearchParams(location.search);
  const fromHash = location.hash.startsWith("#admin=") ? decodeURIComponent(location.hash.slice(7)) : "";
  const token = fromHash || search.get("admin") || "";
  if (token) {
    search.delete("admin");
    const query = search.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${fromHash ? "" : location.hash}`);
    try { sessionStorage.setItem("mandateAdmin", token); } catch { /* private mode: memory only */ }
    return token;
  }
  try { return sessionStorage.getItem("mandateAdmin") ?? ""; } catch { return ""; }
}

const INTENT_TYPES = {
  AllocationIntent: [
    { name: "allocator", type: "address" },
    { name: "vault", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minShares", type: "uint256" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

// --- formatting ---------------------------------------------------------
const usd = (value6) =>
  `$${Number(ethers.formatUnits(value6, 6)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const usdc = (value6) =>
  `${Number(ethers.formatUnits(value6, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const nav4 = (value18) => Number(ethers.formatUnits(value18, 18)).toFixed(4);
// An empty vault has no equity to lever, so the ratio is undefined rather
// than infinite. Printing the JS "Infinity" there looks like a broken read.
const lev = (x100) => (Number.isFinite(x100) ? `${(x100 / 100).toFixed(2)}×` : "—");
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// --- terms --------------------------------------------------------------
// A book deployed before MandateFactory carries no trade terms, fees or second
// market. Everything below falls back to that older shape when the factory is
// absent, so the hosted book keeps working until it is redeployed.
const MARKET_FALLBACK = [{ id: 0, symbol: "ETH" }];
const DIRECTION_NAMES = ["long or short", "long only", "short only"];
// MandateRiskGuard.UNOBSERVABLE_MARK_AGES: a mark this many limits old lets
// anyone freeze the vault with freezeUnobservable().
const UNOBSERVABLE_MARK_AGES = 3;
const FREEZE_REASONS = ["", "drawdown", "unobservable mark", "daily loss", "holding time"];
const PUBLIC_RPC = { 10143: "https://testnet-rpc.monad.xyz" };
const hasTerms = () => Boolean(state.deployment?.addresses?.factory);
const marketsOf = () => state.deployment?.markets ?? MARKET_FALLBACK;
const marketSymbol = (id) => marketsOf().find((m) => m.id === Number(id))?.symbol ?? `market ${id}`;
const allowedMask = (vault) => Number(vault.trade?.allowedMarkets ?? 1);
const marketNames = (mask) =>
  marketsOf()
    .filter((m) => (Number(mask) >> m.id) & 1)
    .map((m) => m.symbol)
    .join(" + ") || "none";
const usdE18 = (value) => usd(BigInt(value) / ASSET_TO_E18);
function duration(seconds) {
  const s = Number(seconds);
  if (s >= 86400 && s % 3600 === 0) return `${(s / 86400).toFixed(s % 86400 ? 1 : 0)}d`;
  if (s >= 3600) return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ""}`.trim();
  return `${s}s`;
}
function homeMarket(vault) {
  const mask = allowedMask(vault);
  for (const m of marketsOf()) if ((mask >> m.id) & 1) return m.id;
  return 0;
}
const priceOfMarket = (id) => state.marketPrices[id] ?? (id === 0 ? state.price : 0n);
function sizeOf(vault, marketId) {
  if (vault.terms) return vault.terms.sizes[marketId] ?? 0n;
  return marketId === 0 && state.price > 0n ? (vault.positionNotional * ONE) / state.price : 0n;
}
// +1 or -1: which way an order adds exposure in this vault. Long-only and
// short-only mandates have one answer; otherwise follow the open position.
function riskSign(vault, marketId) {
  const direction = Number(vault.trade?.direction ?? 0);
  if (direction === 1) return 1n;
  if (direction === 2) return -1n;
  return sizeOf(vault, marketId) < 0n ? -1n : 1n;
}

const toast = $("#toast");
let toastTimer = null;
function showToast(message) {
  const isError = /^(failed|reverted|could not|error)|\b(failed|error)\b/i.test(String(message));
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-live", isError ? "assertive" : "polite");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

// --- revert decoding ----------------------------------------------------
// A vault's ABI does not carry the guard's errors, so the two are merged into
// one interface and revert data is decoded by hand. Showing "LeverageExceeded"
// instead of "execution reverted" is the difference between a demo and a claim.
function buildErrorInterface(abis) {
  const seen = new Set();
  const fragments = [];
  for (const abi of Object.values(abis)) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const signature = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      fragments.push(item);
    }
  }
  return new ethers.Interface(fragments);
}

function describeRevert(error) {
  const data =
    error?.data ??
    error?.info?.error?.data ??
    error?.error?.data ??
    error?.cause?.data ??
    error?.revert?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = state.errorInterface.parseError(data);
      if (parsed) {
        const args = parsed.fragment.inputs.map((input, i) => `${input.name}=${parsed.args[i]}`);
        return { name: parsed.name, detail: args.join(", "), reverted: true };
      }
    } catch (ignored) {
      /* fall through to the raw message */
    }
  }
  if (error?.code === "ACTION_REJECTED") return { name: "rejected", detail: "", reverted: false };
  return {
    name: error?.shortMessage ?? error?.message ?? String(error),
    detail: "",
    reverted: error?.code === "CALL_EXCEPTION"
  };
}

// --- boot ---------------------------------------------------------------
// A book deployed before the batch allocator and the registry existed carries
// neither. The page still has to boot on it: the two screens that read those
// contracts are taken out of the navigation instead.
function optionalContracts(deployment, provider) {
  const { abis, batch, registry } = deployment;
  return {
    batch: batch ? new ethers.Contract(batch.address, abis.batch, provider) : null,
    registry: registry ? new ethers.Contract(registry.address, abis.registry, provider) : null,
    factory:
      deployment.addresses.factory && abis.factory
        ? new ethers.Contract(deployment.addresses.factory, abis.factory, provider)
        : null
  };
}

function applyFeatures(deployment) {
  const present = {
    batch: Boolean(deployment.batch),
    privacy: Boolean(deployment.registry),
    launch: Boolean(deployment.addresses.factory)
  };
  for (const [name, has] of Object.entries(present)) {
    const button = document.querySelector(`.nav [data-route="${name}"]`);
    if (button) button.hidden = !has;
  }
  const current = location.hash.slice(1);
  if (current in present && !present[current]) route("market");
}

async function boot() {
  const deployment = await (await fetch("/api/deployment")).json();
  state.deployment = deployment;

  const provider = new ethers.JsonRpcProvider(new URL("/rpc", window.location.href).toString(), deployment.chainId, {
    staticNetwork: true,
    batchMaxCount: 60,
    cacheTimeout: -1
  });
  provider.pollingInterval = 1000;
  state.provider = provider;
  state.errorInterface = buildErrorInterface(deployment.abis);

  const { addresses, abis } = deployment;
  state.contracts = {
    guard: new ethers.Contract(addresses.guard, abis.guard, provider),
    venue: new ethers.Contract(addresses.venue, abis.venue, provider),
    adapter: new ethers.Contract(addresses.adapter, abis.adapter, provider),
    usdc: new ethers.Contract(addresses.usdc, abis.usdc, provider),
    ...optionalContracts(deployment, provider),
    vaults: deployment.vaults.map((v) => new ethers.Contract(v.address, abis.vault, provider))
  };
  applyFeatures(deployment);
  state.eventInterfaces = eventInterfacesFor(abis);

  state.live = Boolean(deployment.live);
  state.network = deployment.network ?? null;
  $("#chainLabel").textContent = state.live
    ? `${state.network?.label ?? "Live"} · chain ${deployment.chainId}`
    : `Local EDR · chain ${deployment.chainId}`;
  document.body.classList.toggle("live", state.live);
  document.body.classList.toggle("admin", state.live && Boolean(state.adminToken));
  state.lastScannedBlock = Math.max(0, (deployment.startBlock ?? 1) - 1);

  // Block cadence lives on the server, so a reload has to ask for it. Without
  // this the toggle snaps back to 1s while the chain is still mining every 12.
  const status = await (await fetch("/api/control")).json();
  state.blockTimeSeconds = status.blockTimeSeconds;
  state.oracle = status.oracle ?? null;
  state.gas = status.gas ?? null;
  $$("[data-blocktime]").forEach((button) =>
    button.classList.toggle("active", Number(button.dataset.blocktime) === state.blockTimeSeconds)
  );

  buildLeaderboardSkeleton();
  updateSimulator();
  initLaunch();
  await refresh();
  // A public RPC meters eth_call per request and a refresh is ~40 of them, so
  // the live page polls at a third of the local pace.
  setInterval(() => refresh().catch(reportError), state.live ? 2500 : 900);
  if (state.live) {
    setInterval(async () => {
      try {
        const next = await (await fetch("/api/control")).json();
        state.oracle = next.oracle ?? null;
        state.gas = next.gas ?? null;
        // Someone else reset the demo, or the server did it on its own: this
        // page is still holding the contracts that were replaced.
        const guard = next.reset?.guard;
        if (guard && guard !== state.deployment.addresses.guard && (await adoptDeployment())) {
          showToast("The demo was reset. Fresh contracts loaded.");
        }
      } catch (ignored) {
        // the next refresh reports the outage
      }
    }, 5000);
  }
}

function eventInterfacesFor(abis) {
  return [abis.vault, abis.guard, abis.venue, abis.factory, abis.batch, abis.registry].filter(Boolean).map((abi) => new ethers.Interface(abi));
}

function reportError(error) {
  const { name, detail } = describeRevert(error);
  console.error(error);
  showToast(detail ? `${name} — ${detail}` : name);
}

// --- reading the chain --------------------------------------------------
async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const { contracts, deployment, provider } = state;
    const block = await provider.getBlock("latest");
    state.chainTime = Number(block.timestamp);
    state.blockNumber = block.number;
    state.price = await contracts.venue.priceE18();
    if (hasTerms()) {
      state.marketPrices = await Promise.all(marketsOf().map((m) => contracts.venue.priceOf(m.id)));
      await discoverLaunchedVaults();
    }

    state.snapshot = await Promise.all(
      deployment.vaults.map(async (meta, index) => {
        const vault = contracts.vaults[index];
        // The stress tile answers one question: would the order the "inside
        // mandate" button sends (0.7x of max leverage) pass the volatility clause
        // right now? Quote it at that leverage.
        const hasVol = Number(meta.limits.volWindowSeconds) > 0;
        const stressLevX100 = Math.round(meta.limits.maxLeverageX100 * 0.7);
        const [quote, totalAssets, totalSupply, agentState, position, mark, shares, unwindStepsDone, stress] =
          await Promise.all([
            contracts.guard.quote(meta.address, deployment.addresses.adapter),
            vault.totalAssets(),
            vault.totalSupply(),
            vault.state(),
            contracts.adapter.positionState(meta.address),
            contracts.adapter.markEquity(meta.address),
            state.wallet ? vault.balanceOf(state.wallet) : Promise.resolve(0n),
            vault.unwindStepsDone(),
            hasVol
              ? contracts.guard.stressQuote(meta.address, deployment.addresses.adapter, stressLevX100)
              : Promise.resolve([0n, 0n, 0n])
          ]);

        const terms = hasTerms() ? await readTermState(meta) : null;
        // A guard from before the freeze tiers has no recovery window: 0, unwind at once.
        // Only a frozen vault has one, so an active one skips the call.
        const unwindAllowedAt = agentState === 1n
          ? Number(await contracts.guard.unwindAllowedAt?.(meta.address).catch(() => 0n) ?? 0n)
          : 0;
        // The allocator's redemption request, on vaults that have the queue.
        const redeem = state.wallet && vault.redeemRequestOf
          ? await Promise.all([vault.redeemRequestOf(state.wallet), redeemNotice(vault)])
            .then(([r, notice]) => ({ shares: r.shares, dueAt: r.shares === 0n ? 0 : Number(r.requestedAt + notice) }))
            .catch(() => null)
          : null;
        // Every allocator's standing requests together, on vaults that keep the total.
        const redeemRequested = vault.redeemSharesRequested ? await vault.redeemSharesRequested().catch(() => null) : null;
        const [navPerShare, highWater, drawdownBps, markedAt] = quote;
        const equity6 = mark[0];
        const equityE18 = equity6 * ASSET_TO_E18;
        // No position means no leverage, whatever the equity is. Only a vault
        // that still holds notional against zero equity is truly unbounded.
        // The guard measures leverage on total notional across every market.
        const levX100 =
          position[1] === 0n
            ? 0
            : equityE18 === 0n
              ? Infinity
              : Number((position[1] * 100n) / equityE18);

        return {
          ...meta,
          nav: navPerShare,
          highWater,
          drawdownBps: Number(drawdownBps),
          markedAt: Number(markedAt),
          markAge: Math.max(0, state.chainTime - Number(markedAt)),
          unwindAllowedAt,
          totalAssets,
          totalSupply,
          agentState: Number(agentState),
          unwindStepsDone: Number(unwindStepsDone),
          positionNotional: position[0],
          totalNotional: position[1],
          terms,
          equity6,
          levX100,
          hasVol,
          stressLevX100,
          stressSigmaBps: Number(stress[0]),
          stressMoveBps: Number(stress[1]),
          stressedDrawdownBps: Number(stress[2]),
          userShares: shares,
          redeem,
          redeemRequested
        };
      })
    );

    for (const vault of state.snapshot) {
      const series = state.navSeries.get(vault.key) ?? [];
      const value = Number(ethers.formatUnits(vault.nav, 18));
      if (series.at(-1) !== value) series.push(value);
      if (series.length > 240) series.shift();
      state.navSeries.set(vault.key, series);
    }

    await scanLogs();
    render();
    await refreshBatch();
    await refreshPrivacy();
  } finally {
    state.busy = false;
  }
}

// The state the trade terms are judged on, read from the guard and the venue.
async function readTermState(meta) {
  const { guard, venue } = state.contracts;
  const adapter = state.deployment.addresses.adapter;
  const [daily, trades, openedAt, freeze, sizes] = await Promise.all([
    guard.dailyLossQuote(meta.address, adapter),
    guard.tradesOf(meta.address),
    guard.positionOpenedAt(meta.address),
    guard.freezeOf(meta.address),
    Promise.all(marketsOf().map((m) => venue.positionOf(meta.address, m.id)))
  ]);
  const today = Math.floor(state.chainTime / 86400);
  return {
    dailyLossBps: Number(daily[0]),
    tradesToday: Number(trades[0]) === today ? Number(trades[1]) : 0,
    openedAt: Number(openedAt),
    freezeReason: Number(freeze[0]),
    sizes
  };
}

const limitsFrom = (l) => ({
  maxLeverageX100: Number(l.maxLeverageX100),
  maxDrawdownBps: Number(l.maxDrawdownBps),
  minBlocksBetweenTrades: Number(l.minBlocksBetweenTrades),
  maxMarkAgeSeconds: Number(l.maxMarkAgeSeconds),
  maxOrderNotional: l.maxOrderNotional.toString(),
  maxPositionNotional: l.maxPositionNotional.toString(),
  maxTotalNotional: l.maxTotalNotional.toString(),
  maxBlockNotional: l.maxBlockNotional.toString(),
  volWindowSeconds: Number(l.volWindowSeconds),
  stressHorizonSeconds: Number(l.stressHorizonSeconds),
  stressSigmasX10: Number(l.stressSigmasX10)
});
const tradeFrom = (t) => ({
  allowedMarkets: Number(t.allowedMarkets),
  direction: Number(t.direction),
  maxPriceDeviationBps: Number(t.maxPriceDeviationBps),
  maxTradesPerDay: Number(t.maxTradesPerDay),
  maxDailyLossBps: Number(t.maxDailyLossBps),
  maxHoldingSeconds: Number(t.maxHoldingSeconds)
});
const feesFrom = (f) => ({
  performanceFeeBps: Number(f.performanceFeeBps),
  managementFeeBps: Number(f.managementFeeBps)
});

// Vaults anyone opened through MandateFactory. Their terms are read back from
// the guard, never taken from whoever launched them, so the page shows what
// the contract will enforce.
async function discoverLaunchedVaults() {
  const { factory, guard } = state.contracts;
  if (!factory) return false;
  const count = Number(await factory.vaultCount());
  if (count <= state.factoryCount) return false;
  const start = state.factoryCount;
  const page = await factory.vaultsFrom(start, count - start);
  const found = await Promise.all(
    page.map(async (address, offset) => {
      const number = start + offset + 1;
      const contract = new ethers.Contract(address, state.deployment.abis.vault, state.provider);
      const [limits, trade, fees, termsHash, agent, operator] = await Promise.all([
        guard.limitsOf(address),
        guard.tradeTermsOf(address),
        guard.feesOf(address),
        guard.termsHash(address),
        contract.agent(),
        factory.operatorOf(address)
      ]);
      const t = tradeFrom(trade);
      const l = limitsFrom(limits);
      return {
        contract,
        meta: {
          key: `launched-${address.toLowerCase()}`,
          name: `Mandate #${number}`,
          initials: `#${number}`,
          thesis: `${lev(l.maxLeverageX100)} cap, ${marketNames(t.allowedMarkets)}, ${DIRECTION_NAMES[t.direction] ?? "?"}, launched by ${shortAddress(operator)}`,
          launched: true,
          operator,
          address,
          agent,
          termsHash,
          limits: l,
          trade: t,
          fees: feesFrom(fees)
        }
      };
    })
  );
  // A redeploy while the reads were in flight replaced the book; drop them.
  if (state.contracts.factory !== factory) return false;
  for (const { meta, contract } of found) {
    state.deployment.vaults.push(meta);
    state.contracts.vaults.push(contract);
  }
  state.factoryCount = count;
  buildLeaderboardSkeleton();
  return true;
}

async function scanLogs() {
  let from = state.lastScannedBlock + 1;
  if (from > state.blockNumber) return;
  // A public RPC answers getLogs for a bounded range only (100 blocks on Monad
  // testnet, about 40 seconds). A tab that slept longer than that skips ahead:
  // a gap in the feed, rather than a scan that fails on every refresh from then on.
  const maxRange = state.deployment.logRangeBlocks;
  if (maxRange && state.blockNumber - from > maxRange) from = state.blockNumber - maxRange;
  const addresses = [
    state.deployment.addresses.guard,
    ...(state.deployment.addresses.factory ? [state.deployment.addresses.factory] : []),
    ...(state.deployment.batch?.address && state.deployment.abis.batch ? [state.deployment.batch.address] : []),
    ...(state.deployment.registry?.address && state.deployment.abis.registry ? [state.deployment.registry.address] : []),
    ...state.deployment.vaults.map((v) => v.address)
  ];
  const logs = await state.provider.getLogs({
    fromBlock: from,
    toBlock: state.blockNumber,
    address: addresses
  });
  state.lastScannedBlock = state.blockNumber;

  for (const log of logs) {
    const item = describeLog(log);
    if (item) state.feed.unshift({ ...item, hash: log.transactionHash });
  }
  if (state.feed.length > 40) state.feed.length = 40;
}

function vaultLabel(address) {
  const match = state.deployment.vaults.find(
    (v) => v.address.toLowerCase() === String(address).toLowerCase()
  );
  return match ? match.name : shortAddress(String(address));
}

// AgentState onchain: 0 Active, 1 Frozen, 2 Closed. Frozen still holds the
// position; Closed means unwind() took it off the book and only cash is left.
const STATE_NAMES = ["ACTIVE", "FROZEN", "CLOSED"];
const stateName = (agentState) => STATE_NAMES[agentState] ?? "UNKNOWN";

function describeLog(log) {
  for (const iface of state.eventInterfaces) {
    let parsed = null;
    try {
      parsed = iface.parseLog(log);
    } catch (ignored) {
      continue;
    }
    if (!parsed) continue;
    const at = `#${log.blockNumber}`;
    switch (parsed.name) {
      case "RiskConsumed":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · risk budget consumed ${usd(parsed.args.notional / ASSET_TO_E18)}`,
          tag: "PASS",
          kind: "pass"
        };
      case "Executed":
        return {
          at,
          text: `${vaultLabel(log.address)} · order filled onchain`,
          tag: "SETTLED",
          kind: "pass"
        };
      case "Marked":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · re-marked, NAV ${nav4(parsed.args.navPerShare)}`,
          tag: `${parsed.args.drawdownBps} BPS`,
          kind: "mark"
        };
      case "DrawdownBreach":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · drawdown ${parsed.args.drawdownBps}bps proved by ${shortAddress(parsed.args.caller)}`,
          tag: "BREACH",
          kind: "breach"
        };
      case "Frozen":
        return {
          at,
          text: `${vaultLabel(log.address)} · agent frozen, bounty ${usdc(parsed.args.bounty)} mUSDC`,
          tag: "FROZEN",
          kind: "breach"
        };
      case "Unwound":
        return {
          at,
          text: `${vaultLabel(log.address)} · unwind step ${parsed.args.step}/5 closed ${usd(parsed.args.closedNotional / ASSET_TO_E18)}, realised ${usd(parsed.args.realizedPnl / ASSET_TO_E18)} · bounty ${usdc(parsed.args.bounty)} mUSDC`,
          tag: "UNWIND",
          kind: "mark"
        };
      case "Closed":
        return {
          at,
          text: `${vaultLabel(log.address)} · position fully closed, vault holds cash only`,
          tag: "CLOSED",
          kind: "pass"
        };
      case "DailyLossPause":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · daily loss ${parsed.args.lossBps}bps, new risk paused until ${new Date(Number(parsed.args.resumesAt) * 1000).toUTCString().slice(17, 22)} UTC`,
          tag: "PAUSE",
          kind: "mark"
        };
      case "Resumed":
        return parsed.args.vault
          ? {
              at,
              text: `${vaultLabel(parsed.args.vault)} · mark back inside every limit, resumed by ${shortAddress(parsed.args.caller)}`,
              tag: "RESUME",
              kind: "pass"
            }
          : null;
      case "DailyLossBreach":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · daily loss ${parsed.args.lossBps}bps proved by ${shortAddress(parsed.args.caller)}`,
          tag: "BREACH",
          kind: "breach"
        };
      case "HoldingTimeBreach":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · position held past its limit, proved by ${shortAddress(parsed.args.caller)}`,
          tag: "BREACH",
          kind: "breach"
        };
      case "Unobservable":
        return {
          at,
          text: `${vaultLabel(parsed.args.vault)} · no fresh mark since ${new Date(Number(parsed.args.markedAt) * 1000).toLocaleTimeString()}, frozen by ${shortAddress(parsed.args.caller)}`,
          tag: "BLIND",
          kind: "breach"
        };
      case "FeesAccrued":
        return {
          at,
          text: `${vaultLabel(log.address)} · fees minted to the agent: ${usdc(parsed.args.managementAssets)} management, ${usdc(parsed.args.performanceAssets)} performance`,
          tag: "FEE",
          kind: "mark"
        };
      case "MandateCreated":
        return {
          at,
          text: `new mandate ${shortAddress(parsed.args.vault)} launched by ${shortAddress(parsed.args.operator)}, terms ${parsed.args.termsHash.slice(0, 10)}…`,
          tag: "LISTED",
          kind: "pass"
        };
      case "Allocated":
        return {
          at,
          text: `${vaultLabel(log.address)} · allocated ${usdc(parsed.args.assets)} mUSDC`,
          tag: "MINT",
          kind: "pass"
        };
      case "Withdrawn":
        return {
          at,
          text: `${vaultLabel(log.address)} · withdrew ${usdc(parsed.args.assets)} mUSDC`,
          tag: "BURN",
          kind: "pass"
        };
      case "WithdrawnUnpriced":
        return {
          at,
          text: `${vaultLabel(log.address)} · cash-only exit paid ${usdc(parsed.args.assets)} mUSDC, the open position stays with the vault`,
          tag: "BURN",
          kind: "pass"
        };
      case "SharesTransferred":
        return {
          at,
          text: `${vaultLabel(log.address)} · ${usdc(parsed.args.shares)} shares moved from ${shortAddress(parsed.args.from)} to ${shortAddress(parsed.args.to)}`,
          tag: "SHARES",
          kind: "mark"
        };
      case "EscrowDeposited":
        return { at, text: `batch · ${shortAddress(parsed.args.allocator)} put ${usdc(parsed.args.assets)} mUSDC in escrow`, tag: "ESCROW", kind: "mark" };
      case "EscrowWithdrawn":
        return { at, text: `batch · ${shortAddress(parsed.args.allocator)} took ${usdc(parsed.args.assets)} mUSDC out of escrow`, tag: "ESCROW", kind: "mark" };
      case "IntentCancelled":
        return { at, text: `batch · ${shortAddress(parsed.args.allocator)} cancelled intent #${parsed.args.nonce}`, tag: "INTENT", kind: "mark" };
      case "EpochSettled":
        return {
          at,
          text: `batch · epoch ${parsed.args.epoch} settled, ${parsed.args.intentCount} intent${parsed.args.intentCount === 1n ? "" : "s"} under root ${parsed.args.intentRoot.slice(0, 10)}…`,
          tag: "EPOCH",
          kind: "pass"
        };
      case "VaultAllocated":
        return {
          at,
          text: `batch · epoch ${parsed.args.epoch} put ${usdc(parsed.args.assets)} mUSDC into ${vaultLabel(parsed.args.vault)} in one allocate()`,
          tag: "MINT",
          kind: "pass"
        };
      case "SharesClaimed":
        return {
          at,
          text: `batch · ${shortAddress(parsed.args.allocator)} claimed ${usdc(parsed.args.shares)} shares of ${vaultLabel(parsed.args.vault)}`,
          tag: "CLAIM",
          kind: "pass"
        };
      case "LeaderboardPosted":
        return {
          at,
          text: `registry · leaderboard for epoch ${parsed.args.epoch} posted, ε spent so far ${(Number(parsed.args.cumulativeEpsilonE6) / 1e6).toFixed(2)}`,
          tag: "DP",
          kind: "pass"
        };
      case "AgentRegistered":
        return {
          at,
          text: `registry · ${vaultLabel(parsed.args.vault)} registered, terms ${parsed.args.termsHash.slice(0, 10)}…`,
          tag: "LISTED",
          kind: "pass"
        };
      case "OutcomeRecorded":
        return {
          at,
          text: `registry · ${vaultLabel(parsed.args.vault)} recorded as ${stateName(Number(parsed.args.state))}${parsed.args.reason ? ` (${FREEZE_REASONS[Number(parsed.args.reason)] ?? "unknown"})` : ""}`,
          tag: "RECORD",
          kind: Number(parsed.args.state) === 1 ? "breach" : "mark"
        };
      case "RedeemRequested":
        return {
          at,
          text: `${vaultLabel(log.address)} · ${shortAddress(parsed.args.allocator)} asked to redeem ${usdc(parsed.args.shares)} shares, notice runs until ${new Date(Number(parsed.args.dueAt) * 1000).toLocaleString()}`,
          tag: "NOTICE",
          kind: "mark"
        };
      case "RedeemCancelled":
        return {
          at,
          text: `${vaultLabel(log.address)} · ${shortAddress(parsed.args.allocator)} cancelled a redemption request`,
          tag: "NOTICE",
          kind: "mark"
        };
      case "DeleveragedForRedemption":
        return {
          at,
          text: `${vaultLabel(log.address)} · position cut ${pct(Number(parsed.args.fractionBps))} to pay ${shortAddress(parsed.args.allocator)}, called by ${shortAddress(parsed.args.caller)}`,
          tag: "REDEEM",
          kind: "mark"
        };
      default:
        return null;
    }
  }
  return null;
}

// --- rendering ----------------------------------------------------------
function buildLeaderboardSkeleton() {
  const ordered = [...state.deployment.vaults].sort(
    (a, b) => a.limits.maxDrawdownBps - b.limits.maxDrawdownBps
  );
  $("#leaderboard").innerHTML = ordered
    .map((vault, position) => {
      const index = state.deployment.vaults.indexOf(vault);
      return `<div class="agent-row" data-index="${index}" role="button" tabindex="0" aria-label="Open ${vault.name}">
        <span class="rank">${String(position + 1).padStart(2, "0")}</span>
        <div class="agent-name">
          <div class="agent-glyph${vault.key === "tight" ? " fly" : ""}${vault.launched ? " launched" : ""}">${vault.initials}</div>
          <div><b>${vault.name}</b><small>${vault.thesis}</small></div>
        </div>
        <div class="agent-cell"><b data-cell="nav">—</b><small data-cell="aum">AUM —</small></div>
        <div class="agent-cell hide-mobile"><b data-cell="dd">—</b><small>drawdown / limit</small></div>
        <div class="agent-cell hide-mobile"><b data-cell="lev">—</b><small>leverage / limit</small></div>
        <div class="agent-cell mobile-extra"><b data-cell="age">—</b><small>mark age / limit</small></div>
        <span class="status" data-cell="state">—</span>
      </div>`;
    })
    .join("");
  // Rows carry live cells that render() fills; a rebuilt skeleton has none yet.
  if (state.snapshot.length) renderMarket();
}

// One listener for the table, however many times its rows are rebuilt.
function openAgentRow(event) {
  const row = event.target.closest(".agent-row");
  if (!row) return;
  state.selected = Number(row.dataset.index);
  render();
  route("agent");
}
$("#leaderboard").addEventListener("click", openAgentRow);
$("#leaderboard").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!event.target.classList.contains("agent-row")) return;
  event.preventDefault();
  openAgentRow(event);
});

function render() {
  if (!state.snapshot.length) return;
  renderMarket();
  renderAgent();
  renderAllocate();
  renderRisk();
}

function renderMarket() {
  const totalAum = state.snapshot.reduce((sum, v) => sum + v.totalAssets, 0n);
  const active = state.snapshot.filter((v) => v.agentState === 0).length;
  const closed = state.snapshot.filter((v) => v.agentState === 2).length;
  $("#statAum").textContent = usd(totalAum);
  $("#statAumSub").textContent = `${state.snapshot.length} vaults, one venue`;
  $("#statMandates").textContent = String(active).padStart(2, "0");
  $("#statMandatesSub").textContent = `${state.snapshot.length - active - closed} frozen by RiskGuard${closed ? `, ${closed} closed` : ""}`;
  $("#statPrice").textContent = `$${Number(ethers.formatUnits(state.price, 18)).toFixed(2)}`;
  $("#statPriceSub").textContent = state.live
    ? `block #${state.blockNumber} · oracle every ${state.oracle?.cadenceSeconds ?? "–"}s`
    : `block #${state.blockNumber} · ${state.blockTimeSeconds}s cadence`;

  for (const row of $$("#leaderboard .agent-row")) {
    const vault = state.snapshot[Number(row.dataset.index)];
    // A vault discovered this tick has a row before it has a snapshot.
    if (!vault) continue;
    const cell = (name) => row.querySelector(`[data-cell="${name}"]`);
    cell("nav").textContent = nav4(vault.nav);
    cell("aum").textContent = `AUM ${usd(vault.totalAssets)}`;
    const ddOver = vault.drawdownBps > vault.limits.maxDrawdownBps;
    const levOver = Number.isFinite(vault.levX100) && vault.levX100 > vault.limits.maxLeverageX100;
    const ageOver = vault.markAge > vault.limits.maxMarkAgeSeconds;
    cell("dd").textContent = `${vault.drawdownBps} / ${vault.limits.maxDrawdownBps} bps`;
    cell("dd").classList.toggle("breached", ddOver);
    cell("lev").textContent = `${lev(vault.levX100)} / ${lev(vault.limits.maxLeverageX100)}`;
    cell("lev").classList.toggle("breached", levOver);
    cell("age").textContent = `${vault.markAge}s / ${vault.limits.maxMarkAgeSeconds}s`;
    cell("age").classList.toggle("stale", ageOver);
    // A vault sits Active onchain until someone pokes it, so a breach that
    // nobody has claimed yet is its own state - and the reason poke() pays.
    const breached = vault.agentState === 0 && (ddOver || levOver);
    const status = cell("state");
    status.textContent = vault.agentState !== 0 ? stateName(vault.agentState) : breached ? "OVER LIMIT" : "ACTIVE";
    status.classList.toggle("frozen", vault.agentState === 1);
    status.classList.toggle("closed", vault.agentState === 2);
    status.classList.toggle("warn", breached);
    row.classList.toggle("selected", Number(row.dataset.index) === state.selected);
  }
}

function renderAgent() {
  const vault = state.snapshot[state.selected];
  $("#agentGlyph").textContent = vault.initials;
  $("#agentEyebrow").textContent = `MANDATE · ${stateName(vault.agentState)}`;
  $("#agentName").textContent = vault.name;
  $("#agentThesis").textContent = `${vault.thesis} · ${marketNames(allowedMask(vault))} against USDC on DeterministicMockVenue (a mock venue)`;
  $("#agentNav").textContent = nav4(vault.nav);
  $("#agentNavSub").textContent = `high-water ${nav4(vault.highWater)}`;
  $("#agentDd").textContent = pct(vault.drawdownBps);
  $("#agentDdSub").textContent = `limit ${pct(vault.limits.maxDrawdownBps)}`;
  $("#agentLev").textContent = lev(vault.levX100);
  $("#agentLevSub").textContent = `limit ${lev(vault.limits.maxLeverageX100)}`;
  $("#agentAum").textContent = usd(vault.totalAssets);
  $("#agentAumSub").textContent = `${usdc(vault.totalSupply)} shares outstanding`;
  $("#agentAddress").textContent = vault.address;
  $("#agentKey").textContent = vault.agent;
  // The hash the allocator is asked to accept. Locked onchain before the first
  // deposit, so it cannot drift from what this page showed.
  $("#agentTerms").textContent = `locked ${vault.termsHash.slice(0, 10)}…${vault.termsHash.slice(-6)}`;
  $("#agentTerms").title = vault.termsHash;

  const rows = [
    ["Leverage", vault.levX100, vault.limits.maxLeverageX100, lev(vault.levX100), lev(vault.limits.maxLeverageX100)],
    ["Drawdown", vault.drawdownBps, vault.limits.maxDrawdownBps, pct(vault.drawdownBps), pct(vault.limits.maxDrawdownBps)],
    [
      "Position notional",
      Number(vault.positionNotional / ASSET_TO_E18),
      Number(vault.limits.maxPositionNotional) / 1e12,
      usd(vault.positionNotional / ASSET_TO_E18),
      usd(BigInt(vault.limits.maxPositionNotional) / ASSET_TO_E18)
    ],
    ["Mark age", vault.markAge, vault.limits.maxMarkAgeSeconds, `${vault.markAge}s`, `${vault.limits.maxMarkAgeSeconds}s`]
  ];
  if (vault.hasVol) {
    rows.push([
      `Stressed drawdown (${stressLabel(vault)} at ${lev(vault.stressLevX100)})`,
      vault.stressedDrawdownBps,
      vault.limits.maxDrawdownBps,
      pct(vault.stressedDrawdownBps),
      pct(vault.limits.maxDrawdownBps)
    ]);
  }
  // Redemption requests the agent has had notice of, against the cash that pays them.
  if (vault.redeemRequested > 0n && vault.totalSupply > 0n) {
    const owed6 = (vault.redeemRequested * vault.equity6) / vault.totalSupply;
    rows.push(["Redemptions requested vs cash", Number(owed6), Number(vault.totalAssets), `${usdc(owed6)} mUSDC`, `${usdc(vault.totalAssets)} cash`]);
  }
  $("#agentLimits").innerHTML = rows
    .map(([label, used, limit, usedText, limitText]) => {
      const ratio = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      const over = used > limit;
      return `<div class="risk-row"><div><span>${label}</span><b class="${over ? "breached" : ""}">${usedText} / ${limitText}</b></div><div class="bar${over ? " danger" : ""}"><i style="width:${ratio}%"></i></div></div>`;
    })
    .join("");

  renderNavChart(vault);
  renderTermSheet(vault);
}

// --- term sheet ---------------------------------------------------------
// Every term the guard enforces for this vault, what it reads now, what
// happens when it is crossed, and a button that crosses it. Pre-trade terms
// make execute() revert; state terms let anyone freeze the vault for a bounty.
function termRows(vault) {
  const l = vault.limits;
  const t = vault.trade;
  const f = vault.fees;
  const terms = vault.terms;
  const active = vault.agentState === 0;
  const funded = vault.totalSupply > 0n;
  const reverts = (error) => `execute() reverts: <code>${error}</code>`;
  const freezes = "anyone may freeze it with <code>poke()</code> and take the bounty";
  const rows = [];
  const pre = (row) => rows.push({ group: "pre", ...row });
  const post = (row) => rows.push({ group: "post", ...row });
  const need = active ? null : "the vault is not active";

  // Whichever of the leverage and position caps a growing position meets first
  // is the one an order can cross; the other row says so instead of offering a
  // button that would only ever trip the first.
  const equityE18 = vault.equity6 * ASSET_TO_E18;
  const levCapE18 = (equityE18 * BigInt(l.maxLeverageX100)) / 100n;
  const posCapE18 = BigInt(l.maxPositionNotional) < BigInt(l.maxTotalNotional) ? BigInt(l.maxPositionNotional) : BigInt(l.maxTotalNotional);
  // The guard checks position size before leverage, so a near tie goes to the
  // position cap.
  const leverageBinds = funded && (levCapE18 * 1001n) / 1000n < posCapE18;
  const notFunded = funded ? null : "allocate first: an empty vault has no equity to lever";
  pre({
    id: "leverage",
    term: "Leverage",
    locked: `${lev(l.maxLeverageX100)} of marked equity`,
    now: lev(vault.levX100),
    over: Number.isFinite(vault.levX100) && vault.levX100 > l.maxLeverageX100,
    breach: reverts("LeverageExceeded"),
    action: {
      label: `Climb past ${lev(l.maxLeverageX100)}`,
      blocked: need ?? notFunded ?? (leverageBinds ? null : `the ${usdE18(posCapE18)} position cap comes first at this equity`)
    }
  });
  pre({
    id: "order",
    term: "Order size",
    locked: `${usdE18(l.maxOrderNotional)} per order`,
    now: "per order",
    breach: reverts("OrderNotionalExceeded"),
    action: { label: "Order at 1.2x the cap", blocked: need }
  });
  pre({
    id: "position",
    term: "Position size",
    locked: `${usdE18(l.maxPositionNotional)} per market, ${usdE18(l.maxTotalNotional)} total`,
    now: `${usdE18(vault.positionNotional)} / ${usdE18(vault.totalNotional ?? vault.positionNotional)}`,
    over:
      vault.positionNotional > BigInt(l.maxPositionNotional) ||
      (vault.totalNotional ?? 0n) > BigInt(l.maxTotalNotional),
    breach: reverts("PositionNotionalExceeded"),
    action: {
      label: "Climb past the cap",
      blocked: need ?? notFunded ?? (leverageBinds ? `the ${lev(l.maxLeverageX100)} leverage cap comes first at this equity` : null)
    }
  });
  pre({
    id: "block",
    term: "Per-block volume",
    locked: `${usdE18(l.maxBlockNotional)} per block`,
    now: "one order per click",
    breach: reverts("BlockNotionalExceeded"),
    action: null
  });
  pre({
    id: "cooldown",
    term: "Cooldown",
    locked: l.minBlocksBetweenTrades ? `${l.minBlocksBetweenTrades} blocks between orders` : "off",
    now: "",
    breach: l.minBlocksBetweenTrades ? reverts("CooldownActive") : "nothing to cross",
    action: l.minBlocksBetweenTrades ? { label: "Two orders back to back", blocked: need } : null
  });
  pre({
    id: "markAge",
    term: "Mark age",
    locked: `${l.maxMarkAgeSeconds}s`,
    now: `${vault.markAge}s`,
    over: vault.markAge > l.maxMarkAgeSeconds,
    breach: `${reverts("MarkTooOld")}; allocate() and withdraw() wait too`,
    action: null
  });
  if (t) {
    const blocked = marketsOf().find((m) => !((t.allowedMarkets >> m.id) & 1));
    pre({
      id: "market",
      term: "Markets",
      locked: marketNames(t.allowedMarkets),
      now: terms
        ? marketsOf()
            .map((m) => `${m.symbol} ${Number(ethers.formatUnits(terms.sizes[m.id] ?? 0n, 18)).toFixed(3)}`)
            .join(", ")
        : "",
      breach: reverts("MarketNotAllowed"),
      action: blocked
        ? { label: `Order on ${blocked.symbol}`, blocked: need, market: blocked.id }
        : { label: "Every listed market", blocked: "this mandate allows every market the venue lists" }
    });
    const home = homeMarket(vault);
    const size = terms ? terms.sizes[home] ?? 0n : 0n;
    pre({
      id: "direction",
      term: "Direction",
      locked: DIRECTION_NAMES[t.direction] ?? "?",
      now: size === 0n ? "flat" : size > 0n ? "long" : "short",
      breach: reverts("DirectionNotAllowed"),
      action:
        t.direction === 0
          ? { label: "Both allowed", blocked: "this mandate may go long or short" }
          : { label: t.direction === 1 ? "Open a short" : "Open a long", blocked: need }
    });
    pre({
      id: "deviation",
      term: "Limit price band",
      locked: t.maxPriceDeviationBps ? `${t.maxPriceDeviationBps} bps from the mark` : "off",
      now: t.maxPriceDeviationBps ? `this page quotes ${Math.floor(t.maxPriceDeviationBps / 2)} bps` : "",
      breach: t.maxPriceDeviationBps ? reverts("PriceDeviationExceeded") : "nothing to cross",
      action: t.maxPriceDeviationBps ? { label: "Limit at 2x the band", blocked: need } : null
    });
    const used = terms?.tradesToday ?? 0;
    pre({
      id: "trades",
      term: "Orders per day",
      locked: t.maxTradesPerDay ? `${t.maxTradesPerDay} that add risk, per UTC day` : "off",
      now: t.maxTradesPerDay ? `${used} used today` : "",
      over: t.maxTradesPerDay > 0 && used >= t.maxTradesPerDay,
      breach: t.maxTradesPerDay ? reverts("DailyTradesExceeded") : "nothing to cross",
      action: t.maxTradesPerDay
        ? {
            label: used >= t.maxTradesPerDay ? "Send one more" : `Use one (${used + 1}/${t.maxTradesPerDay})`,
            blocked: need
          }
        : null
    });
  }
  pre({
    id: "stress",
    term: "Stress test",
    locked: vault.hasVol ? `survive a ${stressLabel(vault)} move inside the drawdown cap` : "off",
    now: vault.hasVol ? `${pct(vault.stressedDrawdownBps)} at ${lev(vault.stressLevX100)}` : "",
    over: vault.hasVol && vault.stressedDrawdownBps > l.maxDrawdownBps,
    breach: vault.hasVol ? `${reverts("StressBreach")} for orders that add risk` : "nothing to cross",
    action: null
  });

  post({
    id: "drawdown",
    term: "Drawdown",
    locked: `${pct(l.maxDrawdownBps)} from the high-water NAV`,
    now: pct(vault.drawdownBps),
    over: vault.drawdownBps > l.maxDrawdownBps,
    breach: freezes,
    action: { label: "poke()", blocked: need }
  });
  if (t) {
    post({
      id: "dailyLoss",
      term: "Daily loss",
      locked: t.maxDailyLossBps ? `${pct(t.maxDailyLossBps)} from the day's opening NAV` : "off",
      now: t.maxDailyLossBps ? pct(terms?.dailyLossBps ?? 0) : "",
      over: t.maxDailyLossBps > 0 && (terms?.dailyLossBps ?? 0) > t.maxDailyLossBps,
      breach: !t.maxDailyLossBps
        ? "nothing to cross"
        : state.contracts.guard.interface.getFunction("resume")
          ? `${reverts("DailyLossPaused")} for orders that add risk until the next UTC day; nothing freezes`
          : freezes,
      action: t.maxDailyLossBps ? { label: "poke()", blocked: need } : null
    });
    const held = terms?.openedAt ? Math.max(0, state.chainTime - terms.openedAt) : null;
    post({
      id: "holding",
      term: "Holding time",
      locked: t.maxHoldingSeconds ? `${duration(t.maxHoldingSeconds)} without going flat` : "off",
      now: t.maxHoldingSeconds ? (held === null ? "flat" : `open ${duration(held)}`) : "",
      over: t.maxHoldingSeconds > 0 && held !== null && held > t.maxHoldingSeconds,
      breach: t.maxHoldingSeconds ? freezes : "nothing to cross",
      action: t.maxHoldingSeconds ? { label: "poke()", blocked: need } : null
    });
  }
  const blindAfter = l.maxMarkAgeSeconds * UNOBSERVABLE_MARK_AGES;
  post({
    id: "blind",
    term: "Unobservable",
    locked: `no mark for ${blindAfter}s`,
    now: `${vault.markAge}s since the last mark`,
    over: vault.markAge > blindAfter,
    breach: "anyone may freeze it with <code>freezeUnobservable()</code> and take the bounty",
    action: {
      label: "freezeUnobservable()",
      blocked: need ?? (!funded ? "nothing to protect in an empty vault" : vault.markAge > blindAfter ? null : `the mark is fresher than ${blindAfter}s`)
    }
  });
  if (f) {
    rows.push({
      group: "fee",
      id: "fees",
      term: "Fees",
      locked: `${pct(f.performanceFeeBps)} of gains over the high-water mark, ${pct(f.managementFeeBps)} a year`,
      now: "",
      breach: "paid to the agent in new shares, never in cash",
      action: { label: "accrueFees()", blocked: need }
    });
  }
  return rows;
}

const TERM_GROUPS = {
  pre: "Checked before every order. The order never fills.",
  post: "Checked on the mark. Crossing one needs no order, so anyone may prove it.",
  fee: "Charged by the vault itself."
};

function renderTermSheet(vault) {
  const sheet = $("#termSheet");
  if (!sheet) return;
  const rows = termRows(vault);
  const shape = `${vault.key}:${rows.map((r) => r.id).join(",")}`;
  if (sheet.dataset.shape !== shape) {
    let group = null;
    sheet.innerHTML =
      `<div class="term-head"><span>Term</span><span>Locked value</span><span>Now</span><span>If crossed</span><span></span></div>` +
      rows
        .map((row) => {
          const heading = row.group !== group ? `<div class="term-group">${TERM_GROUPS[row.group]}</div>` : "";
          group = row.group;
          return `${heading}<div class="term-row" data-term="${row.id}">
            <span class="term-name">${row.term}</span>
            <span class="term-locked" data-cell="locked"></span>
            <span class="term-now" data-cell="now"></span>
            <span class="term-breach">${row.breach}</span>
            <span class="term-action">${row.action ? `<button class="button button-secondary button-small" data-test="${row.id}"></button>` : ""}</span>
          </div>`;
        })
        .join("");
    sheet.dataset.shape = shape;
  }
  for (const row of rows) {
    const el = sheet.querySelector(`[data-term="${row.id}"]`);
    el.querySelector('[data-cell="locked"]').textContent = row.locked;
    const now = el.querySelector('[data-cell="now"]');
    now.textContent = row.now || "—";
    now.classList.toggle("breached", Boolean(row.over));
    const button = el.querySelector("[data-test]");
    if (button && !button.dataset.busy) {
      button.textContent = row.action.label;
      button.disabled = Boolean(row.action.blocked);
      button.title = row.action.blocked ?? "";
      if (row.action.market !== undefined) button.dataset.market = row.action.market;
    }
  }
  const reason = vault.terms?.freezeReason;
  $("#termSheetBadge").textContent =
    vault.agentState === 1 && reason ? `FROZEN: ${FREEZE_REASONS[reason]?.toUpperCase()}` : "LOCKED ONCHAIN";
  $("#termSheetBadge").classList.toggle("alarm", vault.agentState === 1);
  $("#termSheetNote").textContent = hasTerms()
    ? `Every value above is read from MandateRiskGuard for ${shortAddress(vault.address)} and hashes to ${vault.termsHash.slice(0, 10)}…, the hash locked before the first deposit. The buttons sign as ${vault.launched ? "this mandate's agent key (your wallet, if you launched it)" : "the demo agent key"}; the order buttons send real orders the guard judges.`
    : "This book predates trade terms and fees: only size, leverage, drawdown, mark age and stress are enforced here. A redeploy brings the full term sheet.";
}

function renderNavChart(vault) {
  const samples = state.navSeries.get(vault.key) ?? [];
  if (samples.length === 0) {
    // Clear the paths, or the previously selected vault's curve stays drawn
    // under this vault's name.
    for (const id of ["#navCurve", "#navArea", "#navHwm"]) $(id).setAttribute("d", "");
    $("#chartRange").textContent = "waiting for the first mark";
    $("#chartStart").textContent = "—";
    $("#chartEnd").textContent = "—";
    return;
  }
  // A NAV that has not moved is a flat line, not a missing chart. On a quiet
  // market the single sample is doubled so the line draws instead of nothing.
  const series = samples.length === 1 ? [samples[0], samples[0]] : samples;
  const hwm = Number(ethers.formatUnits(vault.highWater, 18));
  const values = [...series, hwm];
  // The high-water mark is one end of the domain, so without padding a vault
  // sitting well below it draws its NAV line flat along the floor of the box.
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = (high - low || 1e-4) * 0.18;
  const min = low - pad;
  const max = high + pad;
  const span = max - min || 1e-6;
  const x = (i) => (i / (series.length - 1)) * 720;
  const y = (value) => 240 - ((value - min) / span) * 220;

  const points = series.map((value, i) => `${x(i).toFixed(1)} ${y(value).toFixed(1)}`);
  $("#navCurve").setAttribute("d", `M${points.join(" L")}`);
  $("#navArea").setAttribute("d", `M${points.join(" L")} L720 260 L0 260Z`);
  $("#navHwm").setAttribute("d", `M0 ${y(hwm).toFixed(1)} L720 ${y(hwm).toFixed(1)}`);
  $("#chartRange").textContent = `${samples.length} SAMPLE${samples.length === 1 ? "" : "S"} · quote()`;
  $("#chartStart").textContent = series[0].toFixed(4);
  $("#chartEnd").textContent = series.at(-1).toFixed(4);
}

function renderAllocate() {
  const vault = state.snapshot[state.selected];
  $("#allocateTitle").textContent = `Fund ${vault.name}`;
  $("#allocateNav").textContent = `${nav4(vault.nav)} USDC`;
  $("#allocateShares").textContent = state.wallet ? `${usdc(vault.userShares)} shares` : "—";
  // What withdraw() would actually pay right now: the stake valued at the marked
  // price, capped by the cash on hand. A vault holding an in-the-money position
  // is worth more than its balance, and the shares the cash cannot cover stay
  // outstanding until the agent frees some up.
  const fair =
    vault.totalSupply === 0n ? 0n : (vault.userShares * vault.equity6) / vault.totalSupply;
  const claim = fair < vault.totalAssets ? fair : vault.totalAssets;
  $("#allocateClaim").textContent = state.wallet
    ? `${usdc(claim)} mUSDC${claim < fair ? ` of ${usdc(fair)}` : ""}`
    : "—";
  $("#modalAgent").textContent = vault.name;
  $("#modalGlyph").textContent = vault.initials;
  $("#modalVault").textContent = shortAddress(vault.address);

  // A frozen vault still honours withdraw() but allocate() reverts with
  // AgentNotActive. Say so on the button instead of letting the allocator
  // find out from a failed transaction.
  const frozen = vault.agentState !== 0;
  // Both doors are priced off the mark, so a mark past its limit closes both.
  // This is the one condition that can hold a withdrawal, and it is worth
  // saying out loud rather than letting the wallet report MarkTooOld.
  const stale = vault.markAge > vault.limits.maxMarkAgeSeconds;
  const allocateButton = $("#allocateButton");
  allocateButton.disabled = frozen || stale;
  const closed = vault.agentState === 2;
  allocateButton.textContent = closed
    ? "Closed — this mandate is over"
    : stale
      ? `Mark is ${vault.markAge}s old — nothing prices until it refreshes`
      : frozen
        ? "Frozen — allocate() is closed"
        : "Review allocation";
  const withdrawButton = $("#withdrawButton");
  if (!withdrawButton.dataset.busy) {
    // A Closed vault holds no position, so withdraw() skips the mark-age check. A
    // Frozen vault whose mark has stopped offers withdrawUnpriced(): the stake's
    // share of the cash, capped at the last mark, without the part at the venue.
    withdrawButton.disabled = stale && !closed && !frozen;
    withdrawButton.textContent = closed
      ? "Withdraw all shares (cash only, no mark needed)"
      : stale && frozen
        ? "Take the cash-only exit (leaves the venue part to those who stay)"
        : stale
          ? `Waiting on a mark under ${vault.limits.maxMarkAgeSeconds}s`
        : frozen
          ? "Withdraw all shares (still open)"
          : "Withdraw all shares";
  }

  renderRedeem(vault, fair, claim);
  updateAmount($("#allocationAmount").value);
}

// The redemption queue: when the cash on hand cannot pay a stake in full, the
// allocator gives notice with requestRedeem(); once it has run, anyone may make the
// vault free the cash with deleverageForRedemption(), and withdraw() pays it.
// REDEEM_NOTICE is a constant of the contract: read it once per vault address.
const redeemNotices = new Map();
function redeemNotice(vault) {
  const key = vault.target;
  if (!redeemNotices.has(key)) {
    redeemNotices.set(key, vault.REDEEM_NOTICE().catch((error) => {
      redeemNotices.delete(key);
      throw error;
    }));
  }
  return redeemNotices.get(key);
}

function renderRedeem(vault, fair, claim) {
  const row = $("#redeemRow");
  const redeem = vault.redeem;
  const pending = redeem && redeem.shares > 0n;
  // Shown when there is a request to report, or cash that falls short of the stake.
  // A request still standing when the vault froze can be cancelled; nothing else
  // here applies to a vault that is being unwound.
  const frozenWithRequest = pending && vault.agentState !== 0;
  row.hidden = !redeem || (vault.agentState !== 0 && !frozenWithRequest) || (!pending && (vault.userShares === 0n || claim >= fair));
  if (row.hidden) return;
  const button = $("#redeemButton");
  $("#cancelRedeemButton").hidden = !pending;
  if (frozenWithRequest) {
    $("#redeemStatus").textContent =
      `${usdc(redeem.shares)} shares requested, but the vault is not active. Unless it resumes, the unwind turns its position into cash and withdraw() pays from that. Cancelling frees the shares to transfer.`;
    if (!button.dataset.busy) {
      button.disabled = true;
      button.textContent = "Vault not active";
    }
    return;
  }
  if (!pending) {
    $("#redeemStatus").textContent =
      `The vault holds ${usdc(claim)} mUSDC of your ${usdc(fair)}; the rest is in the open position. requestRedeem() gives the agent notice to free it; after the notice anyone can make the vault reduce the position for you.`;
    if (!button.dataset.busy) {
      button.disabled = false;
      button.textContent = `requestRedeem(${usdc(vault.userShares)} shares)`;
    }
    return;
  }
  const due = redeem.dueAt <= state.chainTime;
  const owed = vault.totalSupply === 0n ? 0n : (redeem.shares * vault.equity6) / vault.totalSupply;
  // After a deleverage the notice starts again, but the cash is already there.
  const covered = owed > 0n && vault.totalAssets >= owed;
  $("#redeemStatus").textContent = covered
    ? `${usdc(redeem.shares)} shares requested, and the vault's cash covers them now: withdraw() pays them. Left unclaimed, the agent may put the cash back to work after the grace hour.`
    : due
    ? `${usdc(redeem.shares)} shares requested and the notice has run. deleverageForRedemption() reduces every position by the shortfall plus 5%, and withdraw() then pays from the freed cash.`
    : `${usdc(redeem.shares)} shares requested. The agent has until ${new Date(redeem.dueAt * 1000).toLocaleString()} to free the cash on its own terms.`;
  if (!button.dataset.busy) {
    // The vault, not this page's last mark, decides whether there is cash to free.
    button.disabled = !due || covered;
    button.textContent = covered ? "Cash ready: withdraw above" : due ? "deleverageForRedemption() — free the cash" : "Notice running";
  }
}

// "3.0σ/120s": the size of move the mandate makes the agent survive.
function stressLabel(vault) {
  return `${(vault.limits.stressSigmasX10 / 10).toFixed(1)}σ/${vault.limits.stressHorizonSeconds}s`;
}

function renderRisk() {
  const vault = state.snapshot[state.selected];
  const stale = vault.markAge > vault.limits.maxMarkAgeSeconds;
  $("#controlAgentName").textContent = vault.name;
  $("#feedBlock").textContent = `BLOCK #${state.blockNumber}`;
  $("#guardDd").textContent = `${vault.drawdownBps}`;
  $("#guardDd").dataset.digits = String(String(vault.drawdownBps).length);
  $("#guardDdLimit").textContent = `/ ${vault.limits.maxDrawdownBps} bps`;

  const frozen = vault.agentState === 1;
  const closed = vault.agentState === 2;
  // An unobservable freeze waits out a recovery window before unwind() is allowed.
  const recovering = frozen && vault.unwindStepsDone === 0 && vault.unwindAllowedAt > state.chainTime;
  // Breaching a limit does not freeze anything on its own - the vault stays
  // Active until someone calls poke(). That unclaimed window is its own state
  // and the panel has to name it, or the page reads as if nothing happened.
  const ddOver = vault.drawdownBps > vault.limits.maxDrawdownBps;
  const levOver = Number.isFinite(vault.levX100) && vault.levX100 > vault.limits.maxLeverageX100;
  const breached = vault.agentState === 0 && (ddOver || levOver);
  // The volatility clause is the one limit that blocks before anything is lost:
  // it only ever refuses an order, so it has its own line rather than a state.
  const stressed = vault.agentState === 0 && vault.hasVol && vault.stressedDrawdownBps > vault.limits.maxDrawdownBps;
  const headline = $("#guardHeadline");
  headline.textContent = closed
    ? "Position closed"
    : frozen
      ? "Agent frozen"
      : breached
        ? "Over the limit"
        : stale
          ? "Mark is stale"
          : "Inside the mandate";
  headline.classList.toggle("alarm", frozen || (stale && !closed) || breached);
  $("#guardCopy").textContent = closed
    ? "unwind() took the whole position off the book. The vault holds cash plus whatever was realised, and withdraw() pays it out without waiting on a mark."
    : frozen
      ? recovering
        ? `Frozen because no fresh mark arrived. Until ${new Date(vault.unwindAllowedAt * 1000).toLocaleTimeString()} anyone can call resume(): if the mark is back and every limit holds, the agent trades again on the same terms. After that, unwind() takes over. withdraw() stays open throughout.`
        : `execute() and allocate() are closed. withdraw() is not. Anyone can call unwind() to close the position a fifth at a time (${vault.unwindStepsDone}/5 done) and take 0.01% for the gas.`
      : breached
      ? `${ddOver ? `Drawdown is ${pct(vault.drawdownBps)} against a ${pct(vault.limits.maxDrawdownBps)} mandate` : `Leverage is ${lev(vault.levX100)} against a ${lev(vault.limits.maxLeverageX100)} mandate`}. Nothing freezes until someone calls poke() - and whoever does is paid for it.`
      : stale
        ? `The last mark is ${vault.markAge}s old and this mandate accepts ${vault.limits.maxMarkAgeSeconds}s. The guard will refuse to act on it.`
        : stressed
          ? `Realised volatility is ${vault.stressSigmaBps} bps over ${vault.limits.stressHorizonSeconds}s. An order adding exposure at ${lev(vault.stressLevX100)} would sit ${pct(vault.stressedDrawdownBps)} under water after a ${stressLabel(vault)} move, past the ${pct(vault.limits.maxDrawdownBps)} mandate, so execute() refuses it with StressBreach. Reducing orders still pass; the estimate decays as calm marks arrive.`
          : "Every monitored limit is inside the terms the allocator accepted.";
  const pill = $("#pillMark");
  pill.textContent = `mark ${vault.markAge}s / ${vault.limits.maxMarkAgeSeconds}s`;
  pill.classList.toggle("stale", stale && !closed);

  const tile = (id, bar, value, used, limit, limitText) => {
    $(id).textContent = value;
    $(bar).style.width = `${limit > 0 ? Math.min(100, (used / limit) * 100) : 0}%`;
    $(bar).parentElement.classList.toggle("danger", used > limit);
    $(`${id}Limit`).textContent = limitText;
  };
  tile("#tileLev", "#barLev", lev(vault.levX100), vault.levX100, vault.limits.maxLeverageX100, `Limit ${lev(vault.limits.maxLeverageX100)}`);
  tile(
    "#tilePos",
    "#barPos",
    usd(vault.positionNotional / ASSET_TO_E18),
    Number(vault.positionNotional / ASSET_TO_E18),
    Number(BigInt(vault.limits.maxPositionNotional) / ASSET_TO_E18),
    `Limit ${usd(BigInt(vault.limits.maxPositionNotional) / ASSET_TO_E18)}`
  );
  tile("#tileDd", "#barDd", pct(vault.drawdownBps), vault.drawdownBps, vault.limits.maxDrawdownBps, `Limit ${pct(vault.limits.maxDrawdownBps)}`);
  tile("#tileAge", "#barAge", `${vault.markAge}s`, vault.markAge, vault.limits.maxMarkAgeSeconds, `Limit ${vault.limits.maxMarkAgeSeconds}s`);
  if (vault.hasVol) {
    tile(
      "#tileStress",
      "#barStress",
      pct(vault.stressedDrawdownBps),
      vault.stressedDrawdownBps,
      vault.limits.maxDrawdownBps,
      `Limit ${pct(vault.limits.maxDrawdownBps)} · ${stressLabel(vault)} = ${vault.stressMoveBps} bps at ${lev(vault.stressLevX100)}`
    );
  } else {
    tile("#tileStress", "#barStress", "—", 0, 0, "No volatility clause in this mandate");
  }

  $("#pokeButton").textContent = `poke(${vault.name}) — prove the breach, take the bounty`;
  // unwind() only has work to do on a Frozen vault. Keep the button honest about
  // that instead of letting it revert with NotFrozen, but never steal it back
  // from a call that is still in flight.
  const unwindButton = $("#unwindButton");
  if (!unwindButton.dataset.busy) {
    unwindButton.disabled = !frozen || recovering;
    unwindButton.textContent = closed
      ? `unwind(${vault.name}) — already closed`
      : recovering
        ? `unwind(${vault.name}) — recovery window until ${new Date(vault.unwindAllowedAt * 1000).toLocaleTimeString()}`
      : frozen
        ? `unwind(${vault.name}) — step ${vault.unwindStepsDone + 1}/5, close a fifth, take 0.01%`
        : `unwind(${vault.name}) — needs a frozen vault`;
  }

  const resumeButton = $("#resumeButton");
  if (!resumeButton.dataset.busy) {
    resumeButton.hidden = !recovering;
    resumeButton.textContent = `resume(${vault.name}) — re-mark, and lift the freeze if every limit holds`;
  }

  const unenforceable = state.snapshot.filter(
    (v) => v.limits.maxMarkAgeSeconds < state.blockTimeSeconds
  );
  $("#blocktimeNote").textContent = state.live
    ? liveNote()
    : state.blockTimeSeconds === 1
      ? "Mark cadence 1s. Every mandate on this page can be re-marked inside its own mark-age limit."
      : `Oracle held to one mark per 12s, as a 12-second chain would force (the local chain keeps mining). ${
          unenforceable.length
            ? `${unenforceable.map((v) => v.name).join(", ")} asks for a mark no older than ${unenforceable[0].limits.maxMarkAgeSeconds}s, so poke() and execute() now spend most of their time reverting with MarkTooOld.`
            : "Mandates with short mark-age limits become unenforceable."
        }`;

  const explorer = state.network?.explorer;
  $("#eventFeed").innerHTML = state.feed
    .slice(0, 14)
    .map(
      (item) =>
        `<div class="feed-item ${item.kind}"><time>${
          explorer && item.hash ? `<a href="${explorer}/tx/${item.hash}" target="_blank" rel="noopener">${item.at}</a>` : item.at
        }</time><span>${item.text}</span><b>${item.tag}</b></div>`
    )
    .join("");
}

// --- batch allocation -----------------------------------------------------
// The next epoch boundary this wallet's signature should target. A few
// seconds of buffer before an epoch ends avoids a slow click landing an
// intent in an epoch that is already unsettleable by the time it is signed.
function targetEpoch() {
  const b = state.deployment.batch;
  if (!b) return 0;
  const idx = Math.max(0, Math.floor((state.chainTime - b.genesis) / b.epochDuration));
  const end = b.genesis + (idx + 1) * b.epochDuration;
  return end - state.chainTime < 3 ? idx + 1 : idx;
}

async function refreshBatch() {
  if (!state.deployment?.batch) return;
  try {
    state.batch.status = await (await fetch("/api/batch/status")).json();
    if (state.wallet) {
      state.batch.escrow = await state.contracts.batch.escrowOf(state.wallet);
      state.batch.claims = await (
        await fetch(`/api/batch/claims?address=${state.wallet}`)
      ).json();
    } else {
      state.batch.escrow = 0n;
      state.batch.claims = [];
    }
    renderBatch();
  } catch (error) {
    console.error("[batch]", error);
  }
}

function renderBatch() {
  if (!state.snapshot.length || !state.batch.status) return;
  const vault = state.snapshot[state.selected];
  const status = state.batch.status;
  $("#batchVaultLabel").textContent = vault.name;
  $("#batchEscrow").textContent = state.wallet
    ? `${usdc(state.batch.escrow)} mUSDC escrowed`
    : "Connect allocator to read escrow";
  $("#batchEpoch").textContent = String(status.currentEpoch);
  $("#batchEpochEnd").textContent = new Date(status.currentEpochEnd * 1000).toLocaleTimeString();
  $("#batchDeadline").textContent = `${status.settlementWindow}s to settle after each epoch ends`;
  $("#intentTargetEpoch").textContent = `epoch ${targetEpoch()}`;

  $("#pendingIntents").innerHTML = status.pending.length
    ? status.pending
        .map(
          (p) =>
            `<div><b>${String(p.epoch).padStart(2, "0")}</b><span>${usdc(BigInt(p.amount))} mUSDC → ${vaultLabel(p.vault)}</span><em>${shortAddress(p.allocator)}</em></div>`
        )
        .join("")
    : `<div><b>—</b><span>No signed intents waiting</span><em></em></div>`;

  $("#claimList").innerHTML = state.batch.claims.length
    ? state.batch.claims
        .map(
          (c, i) =>
            `<div class="modal-row"><span>${vaultLabel(c.intent.vault)}</span><b>${usdc(BigInt(c.intent.amount))} mUSDC paid in</b><button class="button button-secondary" data-claim="${i}">claimShares()</button></div>`
        )
        .join("")
    : `<p class="disclosure">Nothing settled for this wallet yet.</p>`;
}

$("#depositEscrowButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "approve()…", async (button) => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const amount = ethers.parseUnits(String(Number($("#escrowAmount").value) || 0), 6);
    if (amount === 0n) throw new Error("amount must be greater than zero");
    const signer = await signerFor(state.wallet);
    await (await state.contracts.usdc.connect(signer).approve(state.deployment.batch.address, amount)).wait();
    button.textContent = "depositEscrow()…";
    await (await state.contracts.batch.connect(signer).depositEscrow(amount)).wait();
    showToast(`Deposited ${usdc(amount)} mUSDC to batch escrow`);
  })
);

$("#withdrawEscrowButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "withdrawEscrow()…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const escrow = await state.contracts.batch.escrowOf(state.wallet);
    if (escrow === 0n) throw new Error("no escrow to withdraw");
    const signer = await signerFor(state.wallet);
    await (await state.contracts.batch.connect(signer).withdrawEscrow(escrow)).wait();
    showToast(`Withdrew ${usdc(escrow)} mUSDC from batch escrow`);
  })
);

$("#signIntentButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "signing…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const vault = state.snapshot[state.selected];
    if (vault.launched) throw new Error("the batch allocator only nets into the four demo vaults; allocate to a launched mandate directly");
    const amount = ethers.parseUnits(String(Number($("#intentAmount").value) || 0), 6);
    if (amount === 0n) throw new Error("amount must be greater than zero");

    const b = state.deployment.batch;
    const epoch = targetEpoch();
    const deadline = b.genesis + (epoch + 1) * b.epochDuration + b.settlementWindow;
    // Same estimate updateAmount() uses for the instant Allocate screen, with a
    // 1% tolerance: the epoch's net price is not known until settlement runs.
    const estimatedShares =
      vault.totalSupply === 0n || vault.equity6 === 0n
        ? amount
        : (amount * vault.totalSupply) / vault.equity6;
    const minShares = estimatedShares > 1n ? (estimatedShares * 99n) / 100n : 1n;

    const intent = {
      allocator: state.wallet,
      vault: vault.address,
      amount: amount.toString(),
      minShares: minShares.toString(),
      epoch: String(epoch),
      nonce: String(Date.now()),
      deadline: String(deadline)
    };
    const domain = {
      name: "MandateBatchAllocator",
      version: "1",
      chainId: state.deployment.chainId,
      verifyingContract: b.address
    };
    const signer = await signerFor(state.wallet);
    const signature = await signer.signTypedData(domain, INTENT_TYPES, intent);

    const response = await fetch("/api/batch/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, signature })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "intent rejected");
    showToast(
      result.duplicate
        ? "Already queued"
        : `Intent queued for epoch ${epoch} — ${usdc(amount)} mUSDC into ${vault.name}`
    );
  })
);

$("#settleBatchButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "settleEpoch()…", async () => {
    const response = await fetch("/api/batch/settle", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "settlement failed");
    // A live batcher leaves out an intent the chain would refuse rather than lose the whole epoch to it.
    const dropped = result.dropped ?? [];
    const leftOut = dropped.length ? `; ${dropped.length} left out (${dropped[0].reason})` : "";
    showToast(`Epoch ${result.epoch} settled — ${result.intentCount} intent(s) across ${result.vaultCount} vault(s)${leftOut}`);
  })
);

$("#claimList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-claim]");
  if (!button) return;
  const entry = state.batch.claims[Number(button.dataset.claim)];
  withButton(button, "claimShares()…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const signer = await signerFor(state.wallet);
    await (await state.contracts.batch.connect(signer).claimShares(entry.intent, entry.proof)).wait();
    showToast(`Claimed shares from ${usdc(BigInt(entry.intent.amount))} mUSDC paid into ${vaultLabel(entry.intent.vault)}`);
  });
});

// --- DP reporter / privacy screen ----------------------------------------
const pct2 = (fraction) => `${(fraction * 100).toFixed(2)}%`;
const E6 = 1_000_000;

// Same report-noisy-mean sensitivity the real reporter uses
// (reporter/stats.mjs's laplaceScaleForMean): sensitivity of the mean of N
// values clipped to [-c, c] is 2c/N, and Laplace scale = sensitivity/epsilon.
function laplaceScaleForMean(clipBound, sampleSize, epsilon) {
  if (sampleSize === 0 || epsilon === 0) return Infinity;
  return (2 * clipBound) / (sampleSize * epsilon);
}

async function refreshPrivacy() {
  if (!state.deployment?.registry) return;
  try {
    state.privacy.status = await (await fetch("/api/reporter/status")).json();
    const status = state.privacy.status;
    if (status.hasReleased) {
      // Don't just trust the server's JSON: read the same release back from
      // the contract directly and compare. Every other screen in this app
      // reads the chain for its numbers; this one should too.
      const onchain = await state.contracts.registry.releaseOf(BigInt(status.lastEpoch));
      state.privacy.onchainDigest = onchain.statsDigest;
    } else {
      state.privacy.onchainDigest = null;
    }
    renderPrivacy();
  } catch (error) {
    console.error("[privacy]", error);
  }
}

function renderPrivacy() {
  const status = state.privacy.status;
  if (!status) return;
  const cumulative = Number(status.cumulativeEpsilonE6) / E6;
  const cap = Number(status.epsilonCap) / E6;
  $("#pubEpoch").textContent = status.hasReleased ? status.lastEpoch : "—";
  $("#pubCumulative").textContent = `ε ${cumulative.toFixed(2)}`;
  $("#pubCap").textContent = cap > 0 ? `ε ${cap.toFixed(2)}` : "no cap";
  // The chain keeps a release's digest and its epsilon; the noisy figures
  // themselves are the reporter's. A server that restarted since the last
  // release still reports hasReleased (read from the registry) but no longer
  // holds those figures, so only the onchain digest can be shown.
  const release = status.lastRelease;
  $("#pubSampleSize").textContent = release
    ? String(release.published.sampleSize)
    : `${status.sampleSize} collecting…`;

  const badge = $("#publishedBadge");
  if (!status.hasReleased) {
    badge.textContent = "NO RELEASE YET";
    badge.classList.remove("stale");
  } else if (!release) {
    badge.textContent = "DIGEST ONCHAIN";
    badge.classList.remove("stale");
  } else {
    const verified = state.privacy.onchainDigest === release.statsDigest;
    badge.textContent = verified ? "VERIFIED ONCHAIN" : "DIGEST MISMATCH";
    badge.classList.toggle("stale", !verified);
  }

  if (release) {
    const r = release.published;
    $("#pubMean").textContent = pct2(r.noisyMean);
    $("#pubSharpe").textContent = r.noisySharpe.toFixed(2);
    $("#pubMaxDD").textContent = pct2(r.noisyMaxDrawdown);
    $("#pubDigest").textContent = release.statsDigest;
    $("#pubDigest").title = `tx ${release.txHash}`;
  } else {
    $("#pubMean").textContent = "—";
    $("#pubSharpe").textContent = "—";
    $("#pubMaxDD").textContent = "—";
    $("#pubDigest").textContent = (status.hasReleased && state.privacy.onchainDigest) || "0x…";
    $("#pubDigest").title = "";
  }

  const button = $("#publishReleaseButton");
  if (!button.dataset.busy) {
    const ready = status.sampleSize >= 3;
    button.disabled = !ready;
    button.textContent = ready
      ? `postLeaderboard() — epoch ${status.nextEpoch}`
      : `postLeaderboard() — need ${3 - status.sampleSize} more sample(s)`;
  }
}

$("#publishReleaseButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "building release…", async (button) => {
    button.textContent = "postLeaderboard()…";
    const response = await fetch("/api/reporter/publish", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "release rejected");
    showToast(
      `Epoch ${result.epoch} published — cumulative ε ${(Number(result.cumulativeEpsilonE6) / E6).toFixed(2)}, ${result.published.sampleSize} samples`
    );
  })
);

// Privacy Simulator: pure client-side, synthetic data, same formula as the
// real reporter. No fetch, no contract call -- structurally incapable of
// consuming real epsilon budget, not just conventionally forbidden from it.
const SIM_MEAN_ESTIMATE = 0.05;
const SIM_SAMPLE_SIZE = 200;
function updateSimulator() {
  const slider = $("#simEpsilonSlider");
  const epsilon = Number(slider.value);
  $("#simEpsilonValue").textContent = epsilon.toFixed(2);
  const clipBound = state.deployment?.registry?.clipBound ?? 0.1;
  const scale = laplaceScaleForMean(clipBound, SIM_SAMPLE_SIZE, epsilon);
  const halfWidth = scale * Math.log(20); // 95% two-sided CI for Laplace(0, scale)
  $("#simScale").textContent = scale.toFixed(4);
  $("#simCI").textContent = `${pct2(SIM_MEAN_ESTIMATE - halfWidth)} to ${pct2(SIM_MEAN_ESTIMATE + halfWidth)}`;
}
$("#simEpsilonSlider").addEventListener("input", updateSimulator);

// --- routing ------------------------------------------------------------
function route(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  $$(".nav button").forEach((button) =>
    button.classList.toggle("active", button.dataset.route === name)
  );
  history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-route]");
  if (target) route(target.dataset.route);
});
const knownRoute = (name) => $$(".view").some((view) => view.dataset.view === name);
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (knownRoute(name)) route(name);
});
route(knownRoute(location.hash.slice(1)) ? location.hash.slice(1) : "market");

// --- real venue: Perpl testnet ------------------------------------------
// A separate vault on Monad testnet, read by the server from the public RPC.
// Fetched once when the Market view first shows and on the refresh button; a
// failure leaves the rest of the page untouched.
const aUsd = (value6) => `$${Number(ethers.formatUnits(value6, 6)).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
const ageText = (seconds) => (seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`);

function renderPerpl(p) {
  const link = (path, text) => `<a href="${p.explorer}/${path}" target="_blank" rel="noopener">${text}</a>`;
  const age = Math.max(0, Math.floor(Date.now() / 1000) - p.mark.markedAt);
  const t = p.terms;
  const row = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
  $("#perplBody").innerHTML = `
    <div class="perpl-grid">
      ${row("Vault", link(`address/${p.addresses.vault}`, shortAddress(p.addresses.vault)))}
      ${row("Adapter", link(`address/${p.addresses.adapter}`, shortAddress(p.addresses.adapter)))}
      ${row("Status", p.vault.status)}
      ${row("Position", p.position.totalNotional === "0" ? "flat" : usdE18(p.position.totalNotional))}
      ${row("Equity", aUsd(p.equity.value))}
      ${row("BTC mark", `${usdE18(p.mark.priceE18)} · ${ageText(age)} old`)}
    </div>
    <p class="perpl-terms">Locked terms: BTC only, ${usdE18(t.maxPositionNotional)} position cap, ${pct(t.maxDrawdownBps)} drawdown, ${t.maxMarkAgeSeconds} s mark age.</p>
    ${activity(p)}`;
}

// BTC mark over the agent's latest run, with its fills and refused orders marked.
function agentChart(run, escapeHtml) {
  const pts = (run?.points ?? []).filter((q) => Number.isFinite(q.mark) && Number.isFinite(Date.parse(q.time)));
  if (pts.length < 2) return "";
  const W = 480, H = 240, L = 12, R = 12, T = 16, B = 28;
  const t0 = Date.parse(pts[0].time), t1 = Date.parse(pts.at(-1).time);
  const marks = pts.map((q) => q.mark);
  const lo = Math.min(...marks), hi = Math.max(...marks);
  const pad = (hi - lo || 1) * 0.12;
  const yMin = lo - pad, yMax = hi + pad;
  const x = (q) => L + (t1 === t0 ? 0 : ((Date.parse(q.time) - t0) / (t1 - t0)) * (W - L - R));
  const y = (q) => T + (1 - (q.mark - yMin) / (yMax - yMin)) * (H - T - B);
  const line = pts.map((q, i) => `${i ? "L" : "M"}${x(q).toFixed(1)} ${y(q).toFixed(1)}`).join("");
  const grid = [0, 1, 2, 3].map((i) => { const gy = (T + (i / 3) * (H - T - B)).toFixed(1); return `<path d="M${L} ${gy}H${W - R}"/>`; }).join("");
  const dots = pts.filter((q) => q.kind || q.refused).map((q) => {
    const cx = x(q).toFixed(1), cy = y(q).toFixed(1);
    return `<circle class="${q.kind === "refusal" ? "refusal" : "fill"}" cx="${cx}" cy="${cy}" r="5"/>` +
      (q.refused ? `<circle class="refusal ring" cx="${cx}" cy="${cy}" r="8"/>` : "");
  }).join("");
  const usd = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const multiDay = new Date(t0).toISOString().slice(0, 10) !== new Date(t1).toISOString().slice(0, 10);
  const stamp = (ms) => { const iso = new Date(ms).toISOString(); return multiDay ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16); };
  const yLo = y({ mark: lo }).toFixed(1), yHi = y({ mark: hi }).toFixed(1);
  return `
    <p class="perpl-terms">${escapeHtml(`Run ${run.run}: BTC mark, fills and refusals`)}</p>
    <svg class="perpl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(`BTC mark across run ${run.run}, ${pts.length} readings`)}">
      <g class="grid">${grid}</g>
      <path class="line" d="${line}"/>
      ${dots}
      <text class="lbl" x="${W - R}" y="${Math.max(+yHi - 6, 10)}" text-anchor="end">${escapeHtml(usd(hi))}</text>
      <text class="lbl" x="${W - R}" y="${Math.min(+yLo + 14, H - B - 2)}" text-anchor="end">${escapeHtml(usd(lo))}</text>
      <text class="lbl" x="${L}" y="${H - 6}">${escapeHtml(stamp(t0))} UTC</text>
      <text class="lbl" x="${W - R}" y="${H - 6}" text-anchor="end">${escapeHtml(stamp(t1))} UTC</text>
    </svg>`;
}

// Totals and the latest transactions, from the agent script's own log in the repo.
function activity(p) {
  const a = p.activity;
  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  if (!a?.ticks) return "";
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const tx = (t) => `<a class="perpl-tx ${t.kind}" href="${p.explorer}/tx/${t.hash}" target="_blank" rel="noopener"><i>${t.kind === "fill" ? "filled" : "refused"}</i><em>${escapeHtml(t.label)}</em><span>${day(t.time)} · ${t.hash.slice(0, 10)}…</span></a>`;
  return `
    <div class="perpl-stats">
      <div><b>${a.fills}</b><span>orders filled on Perpl</span></div>
      <div><b>${a.refusals}</b><span>orders past the cap, refused on chain</span></div>
      <div><b>${a.runs}</b><span>runs, ${day(a.firstAt)} to ${day(a.lastAt)} (UTC)</span></div>
    </div>
    ${agentChart(a.latestRun, escapeHtml)}
    <p class="perpl-terms">Latest agent transactions</p>
    <div class="perpl-txs">${a.recent.map(tx).join("")}</div>`;
}

async function refreshPerpl() {
  const button = $("#perplRefresh");
  button.disabled = true;
  try {
    const response = await fetch("/api/perpl");
    if (!response.ok) throw new Error(String(response.status));
    renderPerpl(await response.json());
  } catch {
    $("#perplBody").innerHTML = '<p class="muted">Perpl testnet data is unavailable right now. Try Refresh.</p>';
  } finally {
    button.disabled = false;
  }
}
$("#perplRefresh").addEventListener("click", refreshPerpl);
refreshPerpl();

// --- transactions -------------------------------------------------------
async function withButton(button, label, action) {
  const original = button.textContent;
  button.disabled = true;
  // A refresh tick lands every 900ms and the render functions own these labels.
  // Claim the button for as long as the transaction is in flight so a tick
  // cannot re-enable it underneath a pending withdraw().
  button.dataset.busy = "1";
  button.textContent = label;
  try {
    // The action gets the button because `event.currentTarget` is null once the
    // first await returns - the browser clears it when dispatch finishes.
    await action(button);
  } catch (error) {
    const { name, detail, reverted } = describeRevert(error);
    // A bug in this page is not a guard decision. Labelling one "reverted"
    // sends whoever reads the feed hunting for a rule that never fired.
    const headline = detail ? `${name} (${detail})` : name;
    showToast(reverted ? `reverted: ${headline}` : `failed: ${headline}`);
    if (!reverted) console.error(error);
    state.feed.unshift({
      at: `#${state.blockNumber}`,
      text: `${state.snapshot[state.selected].name} · ${detail ? `${name} — ${detail}` : name}`,
      tag: reverted ? "REVERTED" : "FAILED",
      kind: "breach"
    });
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = original;
    await refresh().catch(reportError);
  }
}

// The signer for an address: the browser wallet when it holds that address,
// otherwise the server's demo key for it (the local chain's unlocked accounts,
// or the hosted demo's keys behind its allowlist).
async function signerFor(address) {
  const injected = state.injected;
  if (injected && address && injected.address.toLowerCase() === String(address).toLowerCase()) {
    return injected.signer;
  }
  return state.provider.getSigner(address);
}

// An order for the adapter. Market 0 keeps the original two-word encoding so a
// book from before multi-market accepts it; any other market adds its id. The
// limit price sits at half the mandate's deviation band, or `bandBps` when the
// caller wants a specific distance from the mark.
function orderFor(vault, sizeDeltaE18, marketId = 0, bandBps = null) {
  const price = priceOfMarket(marketId);
  const dev = Number(vault?.trade?.maxPriceDeviationBps ?? 0);
  const bps = BigInt(bandBps ?? (dev ? Math.floor(dev / 2) : 500));
  const limitPrice = sizeDeltaE18 > 0n ? (price * (10_000n + bps)) / 10_000n : (price * (10_000n - bps)) / 10_000n;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return marketId === 0
    ? coder.encode(["int256", "uint256"], [sizeDeltaE18, limitPrice])
    : coder.encode(["uint256", "int256", "uint256"], [marketId, sizeDeltaE18, limitPrice]);
}

// Size an order on the vault's home market so total notional lands at a target
// leverage of marked equity, which is what the guard measures. Signed, 1e18.
function sizeForLeverage(vault, targetX100) {
  const market = homeMarket(vault);
  const price = priceOfMarket(market);
  const equityE18 = vault.equity6 * ASSET_TO_E18;
  if (equityE18 === 0n || price === 0n) return 0n;
  const otherNotional = (vault.totalNotional ?? vault.positionNotional) - abs(sizeOf(vault, market) * price / ONE);
  const targetNotional = (equityE18 * BigInt(Math.round(targetX100))) / 100n - otherNotional;
  const sign = riskSign(vault, market);
  const targetSize = sign * ((targetNotional > 0n ? targetNotional : 0n) * ONE) / price;
  return targetSize - sizeOf(vault, market);
}
const abs = (x) => (x < 0n ? -x : x);
// Grow the home-market position to `targetNotionalE18` in orders that each fit
// the order and block caps, so the last one meets the cap being tested rather
// than the per-order cap.
async function climbTo(vault, index, targetNotionalE18) {
  const market = homeMarket(vault);
  const price = priceOfMarket(market);
  const l = vault.limits;
  const perOrder = BigInt(l.maxOrderNotional) < BigInt(l.maxBlockNotional) ? BigInt(l.maxOrderNotional) : BigInt(l.maxBlockNotional);
  const step = (((perOrder * 9n) / 10n) * ONE) / price;
  const sign = riskSign(vault, market);
  const otherNotional = (vault.totalNotional ?? vault.positionNotional) - abs((sizeOf(vault, market) * price) / ONE);
  const own = targetNotionalE18 - otherNotional;
  let left = (sign * (own > 0n ? own : 0n) * ONE) / price - sizeOf(vault, market);
  if (left === 0n || (left > 0n) !== (sign > 0n)) throw new Error("the position already sits past that point");
  while (abs(left) > step) {
    const part = left > 0n ? step : -step;
    await sendOrder(vault, index, part, market);
    left -= part;
  }
  await sendOrder(vault, index, left, market);
}
// A size worth `usdAmount` dollars on a market, in the direction that adds risk.
function smallOrder(vault, marketId, usdAmount = 200) {
  const price = priceOfMarket(marketId);
  if (price === 0n) return 0n;
  return (riskSign(vault, marketId) * BigInt(usdAmount) * ONE * ONE) / price;
}

async function sendOrder(vault, index, delta, marketId = 0, bandBps = null) {
  if (delta === 0n) throw new Error("nothing to send: the order rounds to zero");
  const signer = await signerFor(vault.agent);
  const contract = state.contracts.vaults[index].connect(signer);
  return (await contract.execute(state.deployment.addresses.adapter, orderFor(vault, delta, marketId, bandBps))).wait();
}

// --- wallet -------------------------------------------------------------
function setWallet(address, kind) {
  state.wallet = address;
  state.walletKind = kind;
  $("#walletButton").textContent = address ? `${shortAddress(address)}${kind === "injected" ? "" : " · demo"}` : "Connect";
  $("#walletMenu").classList.remove("open");
  document.body.classList.toggle("connected", Boolean(address));
  updateLaunchAgent();
}

async function showBalance() {
  if (!state.wallet) return;
  const balance = await state.contracts.usdc.balanceOf(state.wallet);
  $("#walletBalance").textContent = `Balance ${usdc(balance)} mUSDC`;
}

// A wallet that has never seen this chain is offered it. Live books point the
// wallet at the public RPC; the local chain only exists behind this server.
async function connectInjected() {
  const ethereum = window.ethereum;
  if (!ethereum) throw new Error("no browser wallet found; install one, or use the demo allocator");
  const chainId = state.deployment.chainId;
  const hexId = `0x${chainId.toString(16)}`;
  await ethereum.request({ method: "eth_requestAccounts" });
  const current = await ethereum.request({ method: "eth_chainId" });
  if (current !== hexId) {
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (error) {
      if (error?.code !== 4902 && error?.data?.originalError?.code !== 4902) throw error;
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: state.network?.label ?? `Chain ${chainId}`,
            nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
            rpcUrls: [PUBLIC_RPC[chainId] ?? new URL("/rpc", window.location.href).toString()],
            ...(state.network?.explorer ? { blockExplorerUrls: [state.network.explorer] } : {})
          }
        ]
      });
    }
  }
  const browser = new ethers.BrowserProvider(ethereum, chainId);
  const signer = await browser.getSigner();
  state.injected = { address: await signer.getAddress(), signer };
  if (!state.injectedListening) {
    state.injectedListening = true;
    ethereum.on?.("accountsChanged", (accounts) => {
      if (state.walletKind !== "injected") return;
      if (!accounts.length) {
        state.injected = null;
        return setWallet(null, null);
      }
      connectInjected()
        .then(() => setWallet(state.injected.address, "injected"))
        .then(showBalance)
        .catch(reportError);
    });
    ethereum.on?.("chainChanged", () => {
      if (state.walletKind === "injected") showToast("Your wallet switched networks; reconnect to sign here");
      state.injected = null;
    });
  }
  return state.injected.address;
}

$("#walletButton").addEventListener("click", (event) => {
  event.stopPropagation();
  $("#walletMenu").classList.toggle("open");
  $("#walletInjected").hidden = !window.ethereum;
  $("#walletNoInjected").hidden = Boolean(window.ethereum);
  $("#walletFaucet").disabled = !state.wallet || !hasTerms();
  $("#walletFaucet").title = !hasTerms() ? "this book predates the faucet" : !state.wallet ? "connect first" : "";
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#walletMenu, #walletButton")) $("#walletMenu").classList.remove("open");
});

// Wallet menu a11y: aria-expanded mirrors the open class, Escape closes and
// returns focus, arrows move between visible menu items.
{
  const walletMenu = $("#walletMenu");
  const walletButton = $("#walletButton");
  const items = () => $$("#walletMenu [role=menuitem]").filter((el) => !el.hidden && !el.disabled);
  new MutationObserver(() => {
    const open = walletMenu.classList.contains("open");
    walletButton.setAttribute("aria-expanded", String(open));
    if (open) items()[0]?.focus();
  }).observe(walletMenu, { attributes: true, attributeFilter: ["class"] });
  walletButton.setAttribute("aria-expanded", "false");
  walletMenu.addEventListener("keydown", (event) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    let next = null;
    if (event.key === "ArrowDown") next = list[(at + 1) % list.length];
    else if (event.key === "ArrowUp") next = list[(at - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    if (next) { event.preventDefault(); next.focus(); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !walletMenu.classList.contains("open")) return;
    walletMenu.classList.remove("open");
    walletButton.focus();
  });
}

$("#walletInjected").addEventListener("click", (event) =>
  withButton(event.currentTarget, "waiting for wallet…", async () => {
    const address = await connectInjected();
    setWallet(address, "injected");
    await refresh();
    await showBalance();
    showToast(`${shortAddress(address)} connected from your wallet on ${state.network?.label ?? "this chain"}`);
  })
);

$("#walletDemo").addEventListener("click", async () => {
  setWallet(state.deployment.accounts.allocator, "demo");
  await refresh();
  await showBalance();
  showToast(
    `Demo allocator ${shortAddress(state.wallet)} connected to ${state.live ? state.network?.label ?? "the live chain" : "the local chain"}. The server signs for it.`
  );
});

$("#walletFaucet").addEventListener("click", (event) =>
  withButton(event.currentTarget, "minting…", async () => {
    if (!state.wallet) throw new Error("connect first");
    const response = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: state.wallet })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `faucet answered ${response.status}`);
    const native = BigInt(body.native ?? 0);
    showToast(
      `${usdc(BigInt(body.usdc))} test mUSDC sent to ${shortAddress(body.address)}` +
        (native > 0n ? ` with ${ethers.formatEther(native)} MON for gas` : "")
    );
    await showBalance();
  })
);

// --- allocation ---------------------------------------------------------
const amountInput = $("#allocationAmount");
function updateAmount(value) {
  const vault = state.snapshot[state.selected];
  if (!vault) return;
  const amount = Math.max(0, Number(value) || 0);
  const assets = ethers.parseUnits(amount.toFixed(6), 6);
  // allocate() mints against marked equity, not the cash balance, so the estimate
  // has to price the open position too or it will overstate every entry into a
  // profitable vault.
  const shares =
    vault.totalSupply === 0n || vault.equity6 === 0n
      ? assets
      : (assets * vault.totalSupply) / vault.equity6;
  $("#estimatedShares").textContent = `${usdc(shares)} shares`;
  $("#modalAmount").textContent = `${amount.toLocaleString()} mUSDC`;
  $("#modalShares").textContent = `${usdc(shares)} shares`;
}
amountInput.addEventListener("input", (event) => updateAmount(event.target.value));
$$("[data-amount]").forEach((button) =>
  button.addEventListener("click", () => {
    $$("[data-amount]").forEach((other) => other.classList.remove("active"));
    button.classList.add("active");
    amountInput.value = button.dataset.amount;
    updateAmount(button.dataset.amount);
  })
);

const modal = $("#modal");
$("#allocateButton").addEventListener("click", () => {
  if (!state.wallet) return showToast("Connect the allocator account first");
  updateAmount(amountInput.value);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
});
$$("[data-close-modal]").forEach((element) =>
  element.addEventListener("click", () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  })
);

// Modal a11y: focus moves in on open, returns on close; Escape closes; Tab stays inside.
{
  let opener = null;
  new MutationObserver(() => {
    if (modal.classList.contains("open")) {
      opener = document.activeElement;
      modal.querySelector(".modal-close")?.focus();
    } else if (opener) {
      opener.focus?.();
      opener = null;
    }
  }).observe(modal, { attributes: true, attributeFilter: ["class"] });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    } else if (event.key === "Tab") {
      const f = $$("#modal button, #modal input, #modal select, #modal textarea, #modal a[href]")
        .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}

$("#signIntent").addEventListener("click", (event) =>
  withButton(event.currentTarget, "approve()…", async (button) => {
    const vault = state.snapshot[state.selected];
    const signer = await signerFor(state.wallet);
    const assets = ethers.parseUnits(String(Number(amountInput.value) || 0), 6);
    if (assets === 0n) throw new Error("amount must be greater than zero");
    const usdcContract = state.contracts.usdc.connect(signer);
    await (await usdcContract.approve(vault.address, assets)).wait();
    button.textContent = "allocate()…";
    const vaultContract = state.contracts.vaults[state.selected].connect(signer);
    await (await vaultContract.allocate(assets, state.wallet)).wait();
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    showToast(`Allocated ${usdc(assets)} mUSDC to ${vault.name}`);
    $("#walletBalance").textContent = `Balance ${usdc(await state.contracts.usdc.balanceOf(state.wallet))} mUSDC`;
  })
);

$("#withdrawButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "withdraw()…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const vault = state.snapshot[state.selected];
    if (vault.userShares === 0n) throw new Error("no shares in this vault");
    const signer = await signerFor(state.wallet);
    const vaultContract = state.contracts.vaults[state.selected].connect(signer);
    const stale = vault.markAge > vault.limits.maxMarkAgeSeconds;
    if (vault.agentState === 1 && stale) {
      if (!vaultContract.interface.getFunction("withdrawUnpriced")) {
        throw new Error("this deployment predates the cash-only exit; wait for the mark or the unwind");
      }
      // Ask the chain what it pays now and refuse anything less when it lands.
      const assets = await vaultContract.withdrawUnpriced.staticCall(vault.userShares, state.wallet, 0n);
      await (await vaultContract.withdrawUnpriced(vault.userShares, state.wallet, assets)).wait();
      showToast(`Cash-only exit: ${usdc(assets)} mUSDC paid; the venue part stays with the vault`);
      $("#walletBalance").textContent = `Balance ${usdc(await state.contracts.usdc.balanceOf(state.wallet))} mUSDC`;
      return;
    }
    await (await vaultContract.withdraw(vault.userShares, state.wallet)).wait();
    // The vault pays at the marked price out of the cash it holds, so a stake
    // backed by an open position can come out in parts. Report what is left
    // instead of calling a partial exit "withdrawn".
    const left = await vaultContract.balanceOf(state.wallet);
    showToast(
      left > 0n
        ? `Paid out to the cash on hand — ${usdc(left)} shares stay until the agent frees up more`
        : vault.agentState === 0
          ? "Withdrawn"
          : vault.agentState === 2
            ? "Withdrawn from a closed vault — cash plus realised PnL, no mark needed"
            : "Withdrawn from a frozen vault — the freeze stops the agent, not you"
    );
    $("#walletBalance").textContent = `Balance ${usdc(await state.contracts.usdc.balanceOf(state.wallet))} mUSDC`;
  })
);

$("#redeemButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "redemption…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const vault = state.snapshot[state.selected];
    const signer = await signerFor(state.wallet);
    const vaultContract = state.contracts.vaults[state.selected].connect(signer);
    if (vault.redeem?.shares > 0n) {
      await vaultContract.deleverageForRedemption.staticCall(state.wallet);
      await (await vaultContract.deleverageForRedemption(state.wallet)).wait();
      showToast("Position reduced for your redemption; withdraw() pays from the freed cash");
      return;
    }
    await (await vaultContract.requestRedeem(vault.userShares)).wait();
    showToast(`Redemption requested for ${usdc(vault.userShares)} shares`);
  })
);

$("#cancelRedeemButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "cancelRedeem()…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const signer = await signerFor(state.wallet);
    await (await state.contracts.vaults[state.selected].connect(signer).cancelRedeem()).wait();
    showToast("Redemption request cancelled");
  })
);

// --- agent orders -------------------------------------------------------
$("#compliantOrder").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    const delta = sizeForLeverage(vault, vault.limits.maxLeverageX100 * 0.7);
    if (delta === 0n) throw new Error("already at the target");
    await sendOrder(vault, state.selected, delta, homeMarket(vault));
    showToast(`${vault.name} rebalanced to ~${lev(vault.limits.maxLeverageX100 * 0.7)}`);
  })
);

$("#runViolation").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    const delta = sizeForLeverage(vault, vault.limits.maxLeverageX100 + 80);
    await sendOrder(vault, state.selected, delta, homeMarket(vault));
    showToast("Order went through — it was inside the mandate after all");
  })
);

$("#reduceOrder").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    const market = homeMarket(vault);
    const currentSize = sizeOf(vault, market);
    if (currentSize === 0n) throw new Error("nothing on the book to reduce");
    const delta = -(currentSize / 5n);
    if (delta === 0n) throw new Error("position too small to split");
    await sendOrder(vault, state.selected, delta, market);
    showToast(`${vault.name} cut a fifth of its position. Orders that reduce exposure are never stress-tested.`);
  })
);

$("#pokeButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "poke()…", async () => {
    const vault = state.snapshot[state.selected];
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const before = await state.contracts.usdc.balanceOf(caller);
    const signer = await signerFor(caller);
    const guard = state.contracts.guard.connect(signer);
    await (await guard.poke(vault.address, state.deployment.addresses.adapter)).wait();
    const after = await state.contracts.usdc.balanceOf(caller);
    showToast(
      after > before
        ? `Breach proved. ${shortAddress(caller)} was paid ${usdc(after - before)} mUSDC and ${vault.name} is frozen.`
        : `${vault.name} re-marked, still inside its mandate. No bounty.`
    );
  })
);

$("#resumeButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "resume()…", async () => {
    const vault = state.snapshot[state.selected];
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const guard = state.contracts.guard.connect(await signerFor(caller));
    await (await guard.resume(vault.address)).wait();
    showToast(`${vault.name} is active again on the same terms. ${shortAddress(caller)} lifted the freeze; resume pays no bounty.`);
  })
);

$("#unwindButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "unwind()…", async () => {
    const vault = state.snapshot[state.selected];
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const before = await state.contracts.usdc.balanceOf(caller);
    const signer = await signerFor(caller);
    const contract = state.contracts.vaults[state.selected].connect(signer);
    const receipt = await (await contract.unwind()).wait();
    const after = await state.contracts.usdc.balanceOf(caller);
    const closed = receipt.logs.some((log) => {
      try {
        return contract.interface.parseLog(log)?.name === "Closed";
      } catch (ignored) {
        return false;
      }
    });
    const [remaining] = await state.contracts.adapter.positionState(vault.address);
    showToast(
      closed
        ? `${vault.name} is closed. Nothing is left on the book; ${shortAddress(caller)} took ${usdc(after - before)} mUSDC for the last step.`
        : `Step done. ${usd(remaining / ASSET_TO_E18)} of ${vault.name} still open; ${shortAddress(caller)} was paid ${usdc(after - before)} mUSDC.`
    );
  })
);

// --- term sheet tests ---------------------------------------------------
// Each button sends the transaction that crosses its term and reports what the
// chain answered. A test the guard lets through is reported as such, never
// dressed up as a refusal.
const TERM_TESTS = {
  async leverage(vault, index) {
    const l = vault.limits;
    const levCap = (vault.equity6 * ASSET_TO_E18 * BigInt(l.maxLeverageX100)) / 100n;
    const posCap = BigInt(l.maxPositionNotional);
    // Land past the leverage cap but short of the position cap, which the
    // guard checks first.
    const over = (levCap * 102n) / 100n;
    const between = (levCap + posCap) / 2n;
    await climbTo(vault, index, over < between ? over : between);
    return "Every order filled: the position stayed inside the leverage cap";
  },
  async position(vault, index) {
    const l = vault.limits;
    const cap = BigInt(l.maxPositionNotional) < BigInt(l.maxTotalNotional) ? BigInt(l.maxPositionNotional) : BigInt(l.maxTotalNotional);
    await climbTo(vault, index, (cap * 105n) / 100n);
    return "Every order filled: the position stayed inside the cap";
  },
  async order(vault, index) {
    const market = homeMarket(vault);
    const notional = (BigInt(vault.limits.maxOrderNotional) * 12n) / 10n;
    const size = (riskSign(vault, market) * notional * ONE) / priceOfMarket(market);
    await sendOrder(vault, index, size, market);
    return "The order filled";
  },
  async cooldown(vault, index) {
    const market = homeMarket(vault);
    await sendOrder(vault, index, smallOrder(vault, market), market);
    await sendOrder(vault, index, -smallOrder(vault, market), market);
    return "Both orders filled: they landed further apart than the cooldown";
  },
  async market(vault, index, button) {
    const market = Number(button.dataset.market);
    await sendOrder(vault, index, smallOrder(vault, market), market);
    return `The ${marketSymbol(market)} order filled`;
  },
  async direction(vault, index) {
    const market = homeMarket(vault);
    const size = sizeOf(vault, market);
    const want = vault.trade.direction === 1 ? -1n : 1n;
    const step = (want * 200n * ONE * ONE) / priceOfMarket(market);
    // The flip is one order when it fits under the order cap; otherwise take
    // the position down first with orders that only reduce it, which the
    // direction term always lets through.
    const cap = (BigInt(vault.limits.maxOrderNotional) * ONE) / priceOfMarket(market);
    let left = size;
    while (abs(left) > cap / 2n) {
      const cut = -(left / 2n);
      await sendOrder(vault, index, cut, market);
      left += cut;
    }
    await sendOrder(vault, index, -left + step, market);
    return "The flip filled";
  },
  async deviation(vault, index) {
    const market = homeMarket(vault);
    await sendOrder(vault, index, smallOrder(vault, market), market, vault.trade.maxPriceDeviationBps * 2);
    return "The order filled inside the band";
  },
  async trades(vault, index) {
    const market = homeMarket(vault);
    await sendOrder(vault, index, smallOrder(vault, market), market);
    return `Order ${(vault.terms?.tradesToday ?? 0) + 1} of ${vault.trade.maxTradesPerDay} today filled`;
  },
  drawdown: pokeTest,
  async dailyLoss(vault) {
    // A guard from before the freeze tiers still freezes on a daily loss.
    if (!state.contracts.guard.interface.getFunction("resume")) return pokeTest(vault);
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const guard = state.contracts.guard.connect(await signerFor(caller));
    await (await guard.poke(vault.address, state.deployment.addresses.adapter)).wait();
    const [lossBps] = await state.contracts.guard.dailyLossQuote(vault.address, state.deployment.addresses.adapter);
    return Number(lossBps) > vault.trade.maxDailyLossBps
      ? `${vault.name} re-marked ${pct(Number(lossBps))} down on the day: orders that add risk are refused until the next UTC day. Reducing still works, and no bounty is paid.`
      : `${vault.name} re-marked and is inside its daily loss. Nothing paused.`;
  },
  holding: pokeTest,
  async blind(vault) {
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const before = await state.contracts.usdc.balanceOf(caller);
    const guard = state.contracts.guard.connect(await signerFor(caller));
    await (await guard.freezeUnobservable(vault.address)).wait();
    const paid = (await state.contracts.usdc.balanceOf(caller)) - before;
    return `No fresh mark for ${vault.markAge}s: ${vault.name} is frozen and ${shortAddress(caller)} was paid ${usdc(paid)} mUSDC`;
  },
  async fees(vault, index) {
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const contract = state.contracts.vaults[index].connect(await signerFor(caller));
    const receipt = await (await contract.accrueFees()).wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return contract.interface.parseLog(log);
        } catch (ignored) {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "FeesAccrued");
    return event
      ? `Fees charged: ${usdc(event.args.managementAssets)} management and ${usdc(event.args.performanceAssets)} performance, paid as ${usdc(event.args.shares)} new shares to the agent`
      : "Nothing was owed yet: no time has passed or NAV is under the fee high-water mark";
  }
};

async function pokeTest(vault) {
  const caller = state.wallet ?? state.deployment.accounts.keeper;
  const before = await state.contracts.usdc.balanceOf(caller);
  const guard = state.contracts.guard.connect(await signerFor(caller));
  await (await guard.poke(vault.address, state.deployment.addresses.adapter)).wait();
  const paid = (await state.contracts.usdc.balanceOf(caller)) - before;
  if (paid === 0n) return `${vault.name} re-marked and is still inside every state term. No bounty.`;
  const [reason] = await state.contracts.guard.freezeOf(vault.address);
  return `Breach proved (${FREEZE_REASONS[Number(reason)] ?? "freeze"}). ${shortAddress(caller)} was paid ${usdc(paid)} mUSDC and ${vault.name} is frozen.`;
}

$("#termSheet").addEventListener("click", (event) => {
  const button = event.target.closest("[data-test]");
  if (!button || button.disabled) return;
  const index = state.selected;
  const vault = state.snapshot[index];
  const test = TERM_TESTS[button.dataset.test];
  if (!test) return;
  withButton(button, "sending…", async () => showToast(await test(vault, index, button)));
});

// --- launch -------------------------------------------------------------
// The form mirrors the ranges MandateRiskGuard._configure() and
// MandateFactory.createMandate() enforce, so a mistake is named here instead of
// coming back as InvalidLimits. The chain still has the last word.
const LAUNCH_PRESETS = {
  careful: {
    markets: [0], direction: 1, deviation: 50, trades: 12, leverage: 1.5, order: 5000, block: 5000, position: 10000,
    total: 10000, cooldown: 0, drawdown: 5, dailyLoss: 2, holding: 0, markAge: 30, volWindow: 300, horizon: 300,
    sigmas: 3, perf: 10, mgmt: 1
  },
  balanced: {
    markets: [0], direction: 0, deviation: 100, trades: 48, leverage: 3, order: 10000, block: 10000, position: 20000,
    total: 20000, cooldown: 0, drawdown: 12, dailyLoss: 5, holding: 12, markAge: 30, volWindow: 120, horizon: 120,
    sigmas: 3, perf: 15, mgmt: 1.5
  },
  aggressive: {
    markets: [0, 1], direction: 0, deviation: 150, trades: 96, leverage: 6, order: 20000, block: 20000, position: 30000,
    total: 40000, cooldown: 0, drawdown: 25, dailyLoss: 10, holding: 0, markAge: 30, volWindow: 0, horizon: 0,
    sigmas: 0, perf: 20, mgmt: 2
  }
};
const LAUNCH_FIELDS = {
  direction: "#lfDirection", deviation: "#lfDeviation", trades: "#lfTrades", leverage: "#lfLeverage",
  order: "#lfOrder", block: "#lfBlock", position: "#lfPosition", total: "#lfTotal", cooldown: "#lfCooldown",
  drawdown: "#lfDrawdown", dailyLoss: "#lfDailyLoss", holding: "#lfHolding", markAge: "#lfMarkAge",
  volWindow: "#lfVolWindow", horizon: "#lfHorizon", sigmas: "#lfSigmas", perf: "#lfPerf", mgmt: "#lfMgmt"
};

function applyPreset(name) {
  const preset = LAUNCH_PRESETS[name];
  for (const [key, selector] of Object.entries(LAUNCH_FIELDS)) $(selector).value = preset[key];
  $$("#lfMarkets input").forEach((box) => (box.checked = preset.markets.includes(Number(box.value))));
  $$("[data-preset]").forEach((chip) => chip.classList.toggle("active", chip.dataset.preset === name));
  updateLaunch();
}

function renderLaunchMarkets() {
  $("#lfMarkets").innerHTML = marketsOf()
    .map((m) => `<label class="check"><input type="checkbox" value="${m.id}" />${m.symbol}/USD</label>`)
    .join("");
}

function updateLaunchAgent() {
  const input = $("#lfAgent");
  if (!input) return;
  if (!input.dataset.touched) input.value = state.wallet ?? "";
  $("#lfSigner").textContent = !state.wallet
    ? "Connect first. The account that sends this transaction is recorded as the operator."
    : state.walletKind === "injected"
      ? `Your wallet ${shortAddress(state.wallet)} signs and is recorded as the operator.`
      : state.live
        ? "The demo allocator is not allowed to launch on the hosted chain. Connect a browser wallet to launch."
        : `The demo allocator ${shortAddress(state.wallet)} signs on this local chain and is recorded as the operator.`;
  updateLaunch();
}

// Read the form into the three term structs, or a list of what is wrong.
function readLaunch() {
  const n = (selector) => Number($(selector).value);
  const errors = [];
  const check = (ok, message) => ok || errors.push(message);
  const mask = $$("#lfMarkets input").reduce((m, box) => (box.checked ? m | (1 << Number(box.value)) : m), 0);
  const agent = $("#lfAgent").value.trim();
  check(ethers.isAddress(agent), "Agent key must be an address");
  check(mask !== 0, "Pick at least one market");
  const leverage = Math.round(n("#lfLeverage") * 100);
  check(leverage > 0 && leverage <= 2000, "Leverage must be above 0 and at most 20x");
  const drawdown = Math.round(n("#lfDrawdown") * 100);
  check(drawdown > 0 && drawdown <= 5000, "Drawdown must be above 0 and at most 50%");
  const markAge = Math.round(n("#lfMarkAge"));
  check(markAge >= 1 && markAge <= 60, "Mark age must be 1 to 60 seconds");
  const cooldown = Math.round(n("#lfCooldown"));
  check(cooldown >= 0 && cooldown <= 100000, "Cooldown must be 0 to 100,000 blocks");
  const dollars = {};
  for (const [key, selector, label] of [
    ["order", "#lfOrder", "Per order"],
    ["block", "#lfBlock", "Per block"],
    ["position", "#lfPosition", "Per market"],
    ["total", "#lfTotal", "All markets"]
  ]) {
    dollars[key] = n(selector);
    check(dollars[key] >= 1 && Number.isFinite(dollars[key]), `${label} must be at least $1`);
  }
  check(dollars.order <= dollars.block, "Per order cannot exceed per block");
  check(dollars.position <= dollars.total, "Per market cannot exceed all markets");
  const volWindow = Math.round(n("#lfVolWindow"));
  const horizon = Math.round(n("#lfHorizon"));
  const sigmas = Math.round(n("#lfSigmas") * 10);
  check(volWindow >= 0 && horizon >= 0 && sigmas >= 0 && sigmas <= 65535, "Stress values cannot be negative");
  if (volWindow > 0) {
    check(horizon > 0 && sigmas > 0, "A stress test needs a horizon and a sigma size");
    check((mask & (mask - 1)) === 0, "A stress test reads one price series: pick one market, or set the window to 0");
  }
  const deviation = Math.round(n("#lfDeviation"));
  check(deviation >= 0 && deviation <= 10000, "Price band must be 0 to 10,000 bps");
  const trades = Math.round(n("#lfTrades"));
  check(trades >= 0 && trades <= 65535, "Orders per day must be 0 to 65,535");
  const dailyLoss = Math.round(n("#lfDailyLoss") * 100);
  check(dailyLoss >= 0 && dailyLoss <= 5000, "Daily loss must be 0 to 50%");
  const holding = Math.round(n("#lfHolding") * 3600);
  check(holding >= 0 && holding < 2 ** 32, "Holding time cannot be negative");
  const perf = Math.round(n("#lfPerf") * 100);
  check(perf >= 0 && perf <= 3000, "Performance fee must be 0 to 30%");
  const mgmt = Math.round(n("#lfMgmt") * 100);
  check(mgmt >= 0 && mgmt <= 500, "Management fee must be 0 to 5% a year");
  if (errors.length) return { errors };
  const e18 = (value) => ethers.parseUnits(String(Math.round(value)), 18);
  return {
    errors,
    params: {
      agent: ethers.getAddress(agent),
      adapter: state.deployment.addresses.adapter,
      limits: {
        maxLeverageX100: leverage,
        maxDrawdownBps: drawdown,
        minBlocksBetweenTrades: cooldown,
        maxMarkAgeSeconds: markAge,
        maxOrderNotional: e18(dollars.order),
        maxPositionNotional: e18(dollars.position),
        maxTotalNotional: e18(dollars.total),
        maxBlockNotional: e18(dollars.block),
        volWindowSeconds: volWindow,
        stressHorizonSeconds: volWindow ? horizon : 0,
        stressSigmasX10: volWindow ? sigmas : 0
      },
      trade: {
        allowedMarkets: mask,
        direction: Number($("#lfDirection").value),
        maxPriceDeviationBps: deviation,
        maxTradesPerDay: trades,
        maxDailyLossBps: dailyLoss,
        maxHoldingSeconds: holding
      },
      fees: { performanceFeeBps: perf, managementFeeBps: mgmt },
      modelHash: $("#lfModel").value.trim() ? ethers.id($("#lfModel").value.trim()) : ethers.ZeroHash
    }
  };
}

// A refresh that waits out the tick already in flight instead of skipping.
async function refreshNow() {
  while (state.busy) await new Promise((resolve) => setTimeout(resolve, 100));
  await refresh();
}

// The same hash MandateRiskGuard.termsHash() returns once the vault exists.
function previewTermsHash(params) {
  const fn = state.contracts.factory.interface.getFunction("createMandate");
  const [, , limits, trade, fees] = fn.inputs[0].components;
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode([limits, trade, fees], [params.limits, params.trade, params.fees])
  );
}

function updateLaunch() {
  if (!state.contracts?.factory) return;
  const { errors, params } = readLaunch();
  $("#lfErrors").innerHTML = errors.map((e) => `<li>${e}</li>`).join("");
  $("#lfHash").textContent = params ? previewTermsHash(params) : "fix the fields above";
  const button = $("#launchButton");
  if (!button.dataset.busy) button.disabled = errors.length > 0 || !state.wallet;
}

function initLaunch() {
  if (!state.contracts.factory || $("#lfMarkets").dataset.ready) return;
  $("#lfMarkets").dataset.ready = "1";
  renderLaunchMarkets();
  applyPreset("balanced");
  updateLaunchAgent();
}

$("#launchForm").addEventListener("input", (event) => {
  if (event.target.id === "lfAgent") event.target.dataset.touched = "1";
  updateLaunch();
});
$$("[data-preset]").forEach((chip) => chip.addEventListener("click", () => applyPreset(chip.dataset.preset)));

$("#launchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  withButton($("#launchButton"), "createMandate()…", async () => {
    if (!state.wallet) throw new Error("connect first");
    const { errors, params } = readLaunch();
    if (errors.length) throw new Error(errors[0]);
    const factory = state.contracts.factory.connect(await signerFor(state.wallet));
    const receipt = await (await factory.createMandate(params)).wait();
    const created = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch (ignored) {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "MandateCreated");
    if (!created) throw new Error("the transaction went through but no MandateCreated event came back");
    const address = created.args.vault;
    await refreshNow();
    const index = state.deployment.vaults.findIndex((v) => v.address.toLowerCase() === address.toLowerCase());
    if (index >= 0) state.selected = index;
    render();
    route("agent");
    showToast(`Mandate ${shortAddress(address)} is live with terms ${created.args.termsHash.slice(0, 10)}…. Allocate to it from the Allocate screen.`);
  });
});

function liveNote() {
  const oracle = state.oracle;
  const where = state.network?.label ?? "a live network";
  if (!oracle) return `Live on ${where}. Blocks arrive at the chain's own pace; the oracle is a transaction, not a block hook.`;
  const spent = Number(oracle.spentMon ?? 0).toFixed(2);
  return (
    `Live on ${where}. Every click here is a real transaction signed by a demo key the server holds; nothing to install. ` +
    `The oracle re-marks every ${oracle.cadenceSeconds}s right now (${
      oracle.active ? "someone is watching" : "idle pace"
    }; ${oracle.pushes} marks, ${spent} MON of gas so far)` +
    (oracle.lastError ? `. Last oracle error: ${oracle.lastError}` : ".") +
    (state.gas?.warning ? ` Heads up: ${state.gas.warning}; a click may be refused until that clears.` : "")
  );
}

// --- chain controls -----------------------------------------------------
async function control(op, value) {
  const response = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, value, token: state.adminToken })
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.json();
}

$$("[data-blocktime]").forEach((button) =>
  button.addEventListener("click", async () => {
    const seconds = Number(button.dataset.blocktime);
    await control("blockTime", seconds);
    state.blockTimeSeconds = seconds;
    $$("[data-blocktime]").forEach((other) => other.classList.remove("active"));
    button.classList.add("active");
    showToast(
      seconds === 1
        ? "Oracle now stamps a mark every block, 1s apart"
        : "Oracle now stamps a mark every 12s — the fastest a 12s chain allows"
    );
    await refresh();
  })
);

$$("[data-shock]").forEach((button) =>
  button.addEventListener("click", (event) =>
    withButton(event.currentTarget, "pushing…", async () => {
      await control("shock", Number(button.dataset.shock));
      showToast(`Market moved ${(Number(button.dataset.shock) / 100).toFixed(1)}% — nobody has poked yet`);
    })
  )
);

$("#restorePrice").addEventListener("click", (event) =>
  withButton(event.currentTarget, "restoring…", async () => {
    await control("restorePrice");
    showToast("Mark restored to $2000. High-water marks do not reset.");
  })
);

// Point the page at the book the server holds now. A reset replaces every
// contract, so whatever the page drew or cached from the old ones goes with it.
async function adoptDeployment() {
  const deployment = await (await fetch("/api/deployment")).json();
  if (deployment.addresses.guard === state.deployment.addresses.guard) return false;
  state.deployment = deployment;
  state.contracts.guard = new ethers.Contract(deployment.addresses.guard, deployment.abis.guard, state.provider);
  state.contracts.venue = new ethers.Contract(deployment.addresses.venue, deployment.abis.venue, state.provider);
  state.contracts.adapter = new ethers.Contract(deployment.addresses.adapter, deployment.abis.adapter, state.provider);
  state.contracts.usdc = new ethers.Contract(deployment.addresses.usdc, deployment.abis.usdc, state.provider);
  Object.assign(state.contracts, optionalContracts(deployment, state.provider));
  applyFeatures(deployment);
  state.contracts.vaults = deployment.vaults.map(
    (v) => new ethers.Contract(v.address, deployment.abis.vault, state.provider)
  );
  state.navSeries.clear();
  state.feed = [];
  state.lastScannedBlock = Math.max(0, (deployment.startBlock ?? 1) - 1);
  // A redeploy is a fresh BatchAllocator/MandateRegistry at fresh addresses;
  // anything signed or settled against the old ones no longer applies.
  state.batch = { status: null, escrow: 0n, claims: [] };
  state.privacy = { status: null, onchainDigest: null };
  state.factoryCount = 0;
  state.marketPrices = [];
  state.eventInterfaces = eventInterfacesFor(deployment.abis);
  state.errorInterface = buildErrorInterface(deployment.abis);
  $("#lfMarkets").dataset.ready = "";
  if (state.selected >= deployment.vaults.length) state.selected = 0;
  buildLeaderboardSkeleton();
  updateSimulator();
  initLaunch();
  updateLaunch();
  return true;
}

$("#redeployButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "redeploying…", async () => {
    await control("redeploy");
    await adoptDeployment();
    showToast("Fresh contracts deployed. Four mandates live again.");
  })
);

boot().catch((error) => {
  console.error(error);
  showToast(`Could not reach the chain: ${error.message}`);
});

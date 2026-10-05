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
  adminToken: new URLSearchParams(location.search).get("admin") ?? ""
};

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

const toast = $("#toast");
let toastTimer = null;
function showToast(message) {
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
    registry: registry ? new ethers.Contract(registry.address, abis.registry, provider) : null
  };
}

function applyFeatures(deployment) {
  const present = { batch: Boolean(deployment.batch), privacy: Boolean(deployment.registry) };
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
  state.eventInterfaces = [
    new ethers.Interface(abis.vault),
    new ethers.Interface(abis.guard),
    new ethers.Interface(abis.venue)
  ];

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
      } catch (ignored) {
        // the next refresh reports the outage
      }
    }, 5000);
  }
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

        const [navPerShare, highWater, drawdownBps, markedAt] = quote;
        const equity6 = mark[0];
        const equityE18 = equity6 * ASSET_TO_E18;
        // No position means no leverage, whatever the equity is. Only a vault
        // that still holds notional against zero equity is truly unbounded.
        const levX100 =
          position[0] === 0n
            ? 0
            : equityE18 === 0n
              ? Infinity
              : Number((position[0] * 100n) / equityE18);

        return {
          ...meta,
          nav: navPerShare,
          highWater,
          drawdownBps: Number(drawdownBps),
          markedAt: Number(markedAt),
          markAge: Math.max(0, state.chainTime - Number(markedAt)),
          totalAssets,
          totalSupply,
          agentState: Number(agentState),
          unwindStepsDone: Number(unwindStepsDone),
          positionNotional: position[0],
          equity6,
          levX100,
          hasVol,
          stressLevX100,
          stressSigmaBps: Number(stress[0]),
          stressMoveBps: Number(stress[1]),
          stressedDrawdownBps: Number(stress[2]),
          userShares: shares
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
      return `<div class="agent-row" data-index="${index}">
        <span class="rank">${String(position + 1).padStart(2, "0")}</span>
        <div class="agent-name">
          <div class="agent-glyph${vault.key === "tight" ? " fly" : ""}">${vault.initials}</div>
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

  $("#leaderboard").addEventListener("click", (event) => {
    const row = event.target.closest(".agent-row");
    if (!row) return;
    state.selected = Number(row.dataset.index);
    render();
    route("agent");
  });
}

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
  $("#agentThesis").textContent = `${vault.thesis} · ETH/USDC on DeterministicMockVenue`;
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
  $("#agentLimits").innerHTML = rows
    .map(([label, used, limit, usedText, limitText]) => {
      const ratio = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      const over = used > limit;
      return `<div class="risk-row"><div><span>${label}</span><b class="${over ? "breached" : ""}">${usedText} / ${limitText}</b></div><div class="bar${over ? " danger" : ""}"><i style="width:${ratio}%"></i></div></div>`;
    })
    .join("");

  renderNavChart(vault);
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
    // A Closed vault holds no position, so withdraw() skips the mark-age check.
    withdrawButton.disabled = stale && !closed;
    withdrawButton.textContent = closed
      ? "Withdraw all shares (cash only, no mark needed)"
      : stale
        ? `Waiting on a mark under ${vault.limits.maxMarkAgeSeconds}s`
        : frozen
          ? "Withdraw all shares (still open)"
          : "Withdraw all shares";
  }

  updateAmount($("#allocationAmount").value);
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
      ? `execute() and allocate() are closed. withdraw() is not. Anyone can call unwind() to close the position a fifth at a time (${vault.unwindStepsDone}/5 done) and take 0.01% for the gas.`
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
    unwindButton.disabled = !frozen;
    unwindButton.textContent = closed
      ? `unwind(${vault.name}) — already closed`
      : frozen
        ? `unwind(${vault.name}) — step ${vault.unwindStepsDone + 1}/5, close a fifth, take 0.01%`
        : `unwind(${vault.name}) — needs a frozen vault`;
  }

  const unenforceable = state.snapshot.filter(
    (v) => v.limits.maxMarkAgeSeconds < state.blockTimeSeconds
  );
  $("#blocktimeNote").textContent = state.live
    ? liveNote()
    : state.blockTimeSeconds === 1
      ? "Block cadence 1s. Every mandate on this page can be re-marked inside its own mark-age limit."
      : `Block cadence 12s: the oracle cannot re-stamp a mark more often than a block arrives. ${
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
    const signer = await state.provider.getSigner(state.wallet);
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
    const signer = await state.provider.getSigner(state.wallet);
    await (await state.contracts.batch.connect(signer).withdrawEscrow(escrow)).wait();
    showToast(`Withdrew ${usdc(escrow)} mUSDC from batch escrow`);
  })
);

$("#signIntentButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "signing…", async () => {
    if (!state.wallet) throw new Error("connect the allocator account first");
    const vault = state.snapshot[state.selected];
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
    const signer = await state.provider.getSigner(state.wallet);
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
    const signer = await state.provider.getSigner(state.wallet);
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
route(location.hash.slice(1) || "market");

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

function orderFor(sizeDeltaE18) {
  const limitPrice =
    sizeDeltaE18 > 0n ? (state.price * 105n) / 100n : (state.price * 95n) / 100n;
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["int256", "uint256"],
    [sizeDeltaE18, limitPrice]
  );
}

// Size an order to land at a target leverage against the vault's *mark* equity,
// which is what the guard measures. Returns the signed delta in 1e18 ETH.
function sizeForLeverage(vault, targetX100) {
  const equityE18 = vault.equity6 * ASSET_TO_E18;
  if (equityE18 === 0n || state.price === 0n) return 0n;
  const targetNotional = (equityE18 * BigInt(Math.round(targetX100))) / 100n;
  const targetSize = (targetNotional * ONE) / state.price;
  const currentSize = (vault.positionNotional * ONE) / state.price;
  return targetSize - currentSize;
}

$("#walletButton").addEventListener("click", async (event) => {
  const address = state.deployment.accounts.allocator;
  state.wallet = address;
  event.currentTarget.textContent = shortAddress(address);
  await refresh();
  const balance = await state.contracts.usdc.balanceOf(address);
  $("#walletBalance").textContent = `Balance ${usdc(balance)} mUSDC`;
  showToast(`Allocator ${shortAddress(address)} connected to ${state.live ? state.network?.label ?? "the live chain" : "the local chain"}`);
});

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

$("#signIntent").addEventListener("click", (event) =>
  withButton(event.currentTarget, "approve()…", async (button) => {
    const vault = state.snapshot[state.selected];
    const signer = await state.provider.getSigner(state.wallet);
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
    const signer = await state.provider.getSigner(state.wallet);
    const vaultContract = state.contracts.vaults[state.selected].connect(signer);
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

// --- agent orders -------------------------------------------------------
$("#compliantOrder").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    const delta = sizeForLeverage(vault, vault.limits.maxLeverageX100 * 0.7);
    if (delta === 0n) throw new Error("already at the target");
    const signer = await state.provider.getSigner(vault.agent);
    const contract = state.contracts.vaults[state.selected].connect(signer);
    await (await contract.execute(state.deployment.addresses.adapter, orderFor(delta))).wait();
    showToast(`${vault.name} rebalanced to ~${lev(vault.limits.maxLeverageX100 * 0.7)}`);
  })
);

$("#runViolation").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    const delta = sizeForLeverage(vault, vault.limits.maxLeverageX100 + 80);
    const signer = await state.provider.getSigner(vault.agent);
    const contract = state.contracts.vaults[state.selected].connect(signer);
    await (await contract.execute(state.deployment.addresses.adapter, orderFor(delta))).wait();
    showToast("Order went through — it was inside the mandate after all");
  })
);

$("#reduceOrder").addEventListener("click", (event) =>
  withButton(event.currentTarget, "execute()…", async () => {
    const vault = state.snapshot[state.selected];
    if (vault.positionNotional === 0n || state.price === 0n) throw new Error("nothing on the book to reduce");
    const currentSize = (vault.positionNotional * ONE) / state.price;
    const delta = -(currentSize / 5n);
    if (delta === 0n) throw new Error("position too small to split");
    const signer = await state.provider.getSigner(vault.agent);
    const contract = state.contracts.vaults[state.selected].connect(signer);
    await (await contract.execute(state.deployment.addresses.adapter, orderFor(delta))).wait();
    showToast(`${vault.name} cut a fifth of its position. Orders that reduce exposure are never stress-tested.`);
  })
);

$("#pokeButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "poke()…", async () => {
    const vault = state.snapshot[state.selected];
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const before = await state.contracts.usdc.balanceOf(caller);
    const signer = await state.provider.getSigner(caller);
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

$("#unwindButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "unwind()…", async () => {
    const vault = state.snapshot[state.selected];
    const caller = state.wallet ?? state.deployment.accounts.keeper;
    const before = await state.contracts.usdc.balanceOf(caller);
    const signer = await state.provider.getSigner(caller);
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

$("#redeployButton").addEventListener("click", (event) =>
  withButton(event.currentTarget, "redeploying…", async () => {
    await control("redeploy");
    const deployment = await (await fetch("/api/deployment")).json();
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
    buildLeaderboardSkeleton();
    updateSimulator();
    showToast("Fresh contracts deployed. Four mandates live again.");
  })
);

boot().catch((error) => {
  console.error(error);
  showToast(`Could not reach the chain: ${error.message}`);
});

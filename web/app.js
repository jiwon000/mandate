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
  busy: false
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
    vaults: deployment.vaults.map((v) => new ethers.Contract(v.address, abis.vault, provider))
  };
  state.eventInterfaces = [
    new ethers.Interface(abis.vault),
    new ethers.Interface(abis.guard),
    new ethers.Interface(abis.venue)
  ];

  $("#chainLabel").textContent = `Local EDR · chain ${deployment.chainId}`;
  state.lastScannedBlock = Math.max(0, (deployment.startBlock ?? 1) - 1);

  // Block cadence lives on the server, so a reload has to ask for it. Without
  // this the toggle snaps back to 1s while the chain is still mining every 12.
  const status = await (await fetch("/api/control")).json();
  state.blockTimeSeconds = status.blockTimeSeconds;
  $$("[data-blocktime]").forEach((button) =>
    button.classList.toggle("active", Number(button.dataset.blocktime) === state.blockTimeSeconds)
  );

  buildLeaderboardSkeleton();
  await refresh();
  setInterval(() => refresh().catch(reportError), 900);
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
        const [quote, totalAssets, totalSupply, agentState, position, mark, shares] =
          await Promise.all([
            contracts.guard.quote(meta.address, deployment.addresses.adapter),
            vault.totalAssets(),
            vault.totalSupply(),
            vault.state(),
            contracts.adapter.positionState(meta.address),
            contracts.adapter.markEquity(meta.address),
            state.wallet ? vault.balanceOf(state.wallet) : Promise.resolve(0n)
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
          positionNotional: position[0],
          equity6,
          levX100,
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
  } finally {
    state.busy = false;
  }
}

async function scanLogs() {
  const from = state.lastScannedBlock + 1;
  if (from > state.blockNumber) return;
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
    if (item) state.feed.unshift(item);
  }
  if (state.feed.length > 40) state.feed.length = 40;
}

function vaultLabel(address) {
  const match = state.deployment.vaults.find(
    (v) => v.address.toLowerCase() === String(address).toLowerCase()
  );
  return match ? match.name : shortAddress(String(address));
}

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
  $("#statAum").textContent = usd(totalAum);
  $("#statAumSub").textContent = `${state.snapshot.length} vaults, one venue`;
  $("#statMandates").textContent = String(active).padStart(2, "0");
  $("#statMandatesSub").textContent = `${state.snapshot.length - active} frozen by RiskGuard`;
  $("#statPrice").textContent = `$${Number(ethers.formatUnits(state.price, 18)).toFixed(2)}`;
  $("#statPriceSub").textContent = `block #${state.blockNumber} · ${state.blockTimeSeconds}s cadence`;

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
    status.textContent = vault.agentState !== 0 ? "FROZEN" : breached ? "OVER LIMIT" : "ACTIVE";
    status.classList.toggle("frozen", vault.agentState !== 0);
    status.classList.toggle("warn", breached);
    row.classList.toggle("selected", Number(row.dataset.index) === state.selected);
  }
}

function renderAgent() {
  const vault = state.snapshot[state.selected];
  $("#agentGlyph").textContent = vault.initials;
  $("#agentEyebrow").textContent = `MANDATE · ${vault.agentState === 0 ? "ACTIVE" : "FROZEN"}`;
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
  const claim =
    vault.totalSupply === 0n ? 0n : (vault.userShares * vault.totalAssets) / vault.totalSupply;
  $("#allocateClaim").textContent = state.wallet ? `${usdc(claim)} mUSDC` : "—";
  $("#modalAgent").textContent = vault.name;
  $("#modalGlyph").textContent = vault.initials;
  $("#modalVault").textContent = shortAddress(vault.address);

  // A frozen vault still honours withdraw() but allocate() reverts with
  // AgentNotActive. Say so on the button instead of letting the allocator
  // find out from a failed transaction.
  const frozen = vault.agentState !== 0;
  const allocateButton = $("#allocateButton");
  allocateButton.disabled = frozen;
  allocateButton.textContent = frozen ? "Frozen — allocate() is closed" : "Review allocation";
  $("#withdrawButton").textContent = frozen ? "Withdraw all shares (still open)" : "Withdraw all shares";

  updateAmount($("#allocationAmount").value);
}

function renderRisk() {
  const vault = state.snapshot[state.selected];
  const stale = vault.markAge > vault.limits.maxMarkAgeSeconds;
  $("#controlAgentName").textContent = vault.name;
  $("#feedBlock").textContent = `BLOCK #${state.blockNumber}`;
  $("#guardDd").textContent = `${vault.drawdownBps}`;
  $("#guardDd").dataset.digits = String(String(vault.drawdownBps).length);
  $("#guardDdLimit").textContent = `/ ${vault.limits.maxDrawdownBps} bps`;

  const frozen = vault.agentState !== 0;
  // Breaching a limit does not freeze anything on its own - the vault stays
  // Active until someone calls poke(). That unclaimed window is its own state
  // and the panel has to name it, or the page reads as if nothing happened.
  const ddOver = vault.drawdownBps > vault.limits.maxDrawdownBps;
  const levOver = Number.isFinite(vault.levX100) && vault.levX100 > vault.limits.maxLeverageX100;
  const breached = !frozen && (ddOver || levOver);
  const headline = $("#guardHeadline");
  headline.textContent = frozen
    ? "Agent frozen"
    : breached
      ? "Over the limit"
      : stale
        ? "Mark is stale"
        : "Inside the mandate";
  headline.classList.toggle("alarm", frozen || stale || breached);
  $("#guardCopy").textContent = frozen
    ? "execute() and allocate() are closed. withdraw() is not."
    : breached
      ? `${ddOver ? `Drawdown is ${pct(vault.drawdownBps)} against a ${pct(vault.limits.maxDrawdownBps)} mandate` : `Leverage is ${lev(vault.levX100)} against a ${lev(vault.limits.maxLeverageX100)} mandate`}. Nothing freezes until someone calls poke() - and whoever does is paid for it.`
      : stale
        ? `The last mark is ${vault.markAge}s old and this mandate accepts ${vault.limits.maxMarkAgeSeconds}s. The guard will refuse to act on it.`
        : "Every monitored limit is inside the terms the allocator accepted.";
  const pill = $("#pillMark");
  pill.textContent = `mark ${vault.markAge}s / ${vault.limits.maxMarkAgeSeconds}s`;
  pill.classList.toggle("stale", stale);

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

  $("#pokeButton").textContent = `poke(${vault.name}) — prove the breach, take the bounty`;

  const unenforceable = state.snapshot.filter(
    (v) => v.limits.maxMarkAgeSeconds < state.blockTimeSeconds
  );
  $("#blocktimeNote").textContent =
    state.blockTimeSeconds === 1
      ? "Block cadence 1s. Every mandate on this page can be re-marked inside its own mark-age limit."
      : `Block cadence 12s: the oracle cannot re-stamp a mark more often than a block arrives. ${
          unenforceable.length
            ? `${unenforceable.map((v) => v.name).join(", ")} asks for a mark no older than ${unenforceable[0].limits.maxMarkAgeSeconds}s, so poke() and execute() now spend most of their time reverting with MarkTooOld.`
            : "Mandates with short mark-age limits become unenforceable."
        }`;

  $("#eventFeed").innerHTML = state.feed
    .slice(0, 14)
    .map(
      (item) =>
        `<div class="feed-item ${item.kind}"><time>${item.at}</time><span>${item.text}</span><b>${item.tag}</b></div>`
    )
    .join("");
}

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
  showToast(`Allocator ${shortAddress(address)} connected to the local chain`);
});

// --- allocation ---------------------------------------------------------
const amountInput = $("#allocationAmount");
function updateAmount(value) {
  const vault = state.snapshot[state.selected];
  if (!vault) return;
  const amount = Math.max(0, Number(value) || 0);
  const assets = ethers.parseUnits(amount.toFixed(6), 6);
  const shares =
    vault.totalSupply === 0n || vault.totalAssets === 0n
      ? assets
      : (assets * vault.totalSupply) / vault.totalAssets;
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
    showToast(
      vault.agentState === 0
        ? "Withdrawn"
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

// --- chain controls -----------------------------------------------------
async function control(op, value) {
  const response = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, value })
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
    state.contracts.vaults = deployment.vaults.map(
      (v) => new ethers.Contract(v.address, deployment.abis.vault, state.provider)
    );
    state.navSeries.clear();
    state.feed = [];
    state.lastScannedBlock = Math.max(0, (deployment.startBlock ?? 1) - 1);
    buildLeaderboardSkeleton();
    showToast("Fresh contracts deployed. Four mandates live again.");
  })
);

boot().catch((error) => {
  console.error(error);
  showToast(`Could not reach the chain: ${error.message}`);
});

// An agent's track record, rebuilt from chain events alone.
//
// Allocators choose a vault by its locked terms; this is the other half: what the
// vault actually did under them. MandateRiskGuard emits Marked on every mark and a
// breach event on every freeze, MandateVault emits the money and trade events, so
// nothing here needs an indexer or a trusted server. `summarize` is pure (events in,
// numbers out); `trackRecord` only fetches and then calls it.
import { Contract, Interface, formatUnits, zeroPadValue } from "ethers";

const GUARD_ABI = [
  "event Marked(address indexed vault, uint256 navPerShare, uint256 highWaterNavPerShare, uint256 drawdownBps)",
  "event DrawdownBreach(address indexed vault, address indexed caller, uint256 navPerShare, uint256 drawdownBps, uint256 bounty)",
  // Guards before freeze tiers froze on a daily loss; current ones pause for the day.
  "event DailyLossBreach(address indexed vault, address indexed caller, uint256 navPerShare, uint256 lossBps, uint256 bounty)",
  "event DailyLossPause(address indexed vault, address indexed caller, uint256 navPerShare, uint256 lossBps, uint256 resumesAt)",
  "event Resumed(address indexed vault, address indexed caller, uint256 navPerShare)",
  "event HoldingTimeBreach(address indexed vault, address indexed caller, uint256 openedAt, uint256 bounty)",
  "event Unobservable(address indexed vault, address indexed caller, uint256 markedAt, uint256 bounty)",
  "function limitsOf(address vault) view returns (uint16 maxLeverageX100, uint16 maxDrawdownBps, uint32 minBlocksBetweenTrades, uint32 maxMarkAgeSeconds, uint256 maxOrderNotional, uint256 maxPositionNotional, uint256 maxTotalNotional, uint256 maxBlockNotional, uint32 volWindowSeconds, uint32 stressHorizonSeconds, uint16 stressSigmasX10)",
  "function freezeOf(address vault) view returns (uint8 reason, uint64 frozenAt)"
];

const VAULT_ABI = [
  "event Allocated(address indexed allocator, uint256 assets, uint256 shares)",
  "event Withdrawn(address indexed allocator, uint256 assets, uint256 shares)",
  "event WithdrawnUnpriced(address indexed allocator, uint256 assets, uint256 shares)",
  "event Executed(address indexed adapter, bytes32 indexed orderHash, int256 realizedPnl)",
  "event Frozen(address indexed beneficiary, uint256 bounty)",
  "event Unwound(address indexed caller, uint8 step, uint256 closedNotional, int256 realizedPnl, uint256 bounty)",
  "event Closed()",
  "event FeesAccrued(address indexed agent, uint256 managementAssets, uint256 performanceAssets, uint256 shares)",
  "function state() view returns (uint8)",
  "function asset() view returns (address)"
];

const ERC20_ABI = ["function decimals() view returns (uint8)"];

export const STATES = ["Active", "Frozen", "Closed"];
export const FREEZE_REASONS = ["none", "drawdown", "unobservable", "dailyLoss", "holdingTime"];

const BREACHES = {
  DrawdownBreach: "drawdown",
  DailyLossBreach: "dailyLoss",
  DailyLossPause: "dailyLossPause",
  HoldingTimeBreach: "holdingTime",
  Unobservable: "unobservable"
};

const guardInterface = new Interface(GUARD_ABI);
const vaultInterface = new Interface(VAULT_ABI);

/// eth_getLogs over [from, to] in windows of `chunk` blocks. A window the node
/// refuses (Monad testnet caps the range per call) is split in halves until the
/// node answers or a single block still fails.
export async function getLogsChunked(provider, filter, from, to, chunk = 100) {
  if (!(chunk >= 1)) throw new Error("chunk must be at least 1 block");
  const window = async (start, end) => {
    try {
      return await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    } catch (error) {
      if (end === start) throw error;
      const mid = start + Math.floor((end - start) / 2);
      return [...await window(start, mid), ...await window(mid + 1, end)];
    }
  };
  const logs = [];
  for (let start = from; start <= to; start += chunk) {
    logs.push(...await window(start, Math.min(start + chunk - 1, to)));
  }
  return logs;
}

/// Evenly thin `points` to at most `max` entries, always keeping first and last.
export function downsample(points, max = 200) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

const asNumber = (wei, decimals) => Number(formatUnits(wei, decimals));

/// Pure. `events` are already decoded and time-stamped:
///   { name, blockNumber, logIndex, txHash, time, args: { ... } }
/// `onchain` is what the views said: { limits, state, freeze, decimals }.
export function summarize(events, onchain = {}, { maxPoints = 200 } = {}) {
  const { limits = {}, state, freeze, decimals = 6 } = onchain;
  const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const marks = ordered.filter((e) => e.name === "Marked");

  let maxDrawdownBps = 0n;
  for (const m of marks) if (m.args.drawdownBps > maxDrawdownBps) maxDrawdownBps = m.args.drawdownBps;

  const sum = (names, key) =>
    ordered.filter((e) => names.includes(e.name)).reduce((acc, e) => acc + e.args[key], 0n);
  const count = (name) => ordered.filter((e) => e.name === name).length;

  const first = marks[0];
  const last = marks.at(-1);
  const returnPct = first && last
    ? Number(((last.args.navPerShare - first.args.navPerShare) * 1_000_000n) / first.args.navPerShare) / 10_000
    : null;
  const limitBps = limits.maxDrawdownBps === undefined ? null : Number(limits.maxDrawdownBps);

  const series = downsample(
    marks.map((m) => ({ time: m.time, block: m.blockNumber, nav: asNumber(m.args.navPerShare, 18) })),
    maxPoints
  );

  return {
    marks: marks.length,
    firstMarkTime: first?.time ?? null,
    lastMarkTime: last?.time ?? null,
    navPerShareFirst: first ? asNumber(first.args.navPerShare, 18) : null,
    navPerShareLast: last ? asNumber(last.args.navPerShare, 18) : null,
    returnPct,
    maxDrawdownBps: Number(maxDrawdownBps),
    drawdownLimitBps: limitBps,
    limitUsedPct: limitBps ? Math.round((Number(maxDrawdownBps) * 1000) / limitBps) / 10 : null,
    trades: count("Executed"),
    deposits: formatUnits(sum(["Allocated"], "assets"), decimals),
    withdrawals: formatUnits(sum(["Withdrawn", "WithdrawnUnpriced"], "assets"), decimals),
    fees: {
      management: formatUnits(sum(["FeesAccrued"], "managementAssets"), decimals),
      performance: formatUnits(sum(["FeesAccrued"], "performanceAssets"), decimals)
    },
    breaches: ordered
      .filter((e) => BREACHES[e.name])
      .map((e) => ({
        type: BREACHES[e.name],
        time: e.time,
        block: e.blockNumber,
        txHash: e.txHash,
        drawdownBps: e.name === "DrawdownBreach" ? Number(e.args.drawdownBps) : undefined,
        lossBps: e.name === "DailyLossBreach" || e.name === "DailyLossPause" ? Number(e.args.lossBps) : undefined
      })),
    resumes: count("Resumed"),
    unwindSteps: count("Unwound"),
    closed: count("Closed") > 0,
    state: state === undefined ? null : (STATES[Number(state)] ?? String(state)),
    freezeReason: freeze ? (FREEZE_REASONS[Number(freeze.reason)] ?? String(freeze.reason)) : null,
    frozenAt: freeze && Number(freeze.frozenAt) ? Number(freeze.frozenAt) : null,
    navSeries: series
  };
}

/// Fetch the events and the views for one vault, then summarize.
export async function trackRecord(provider, { guard, vault, fromBlock = 0, toBlock, chunk = 100, maxPoints = 200 }) {
  const to = toBlock ?? await provider.getBlockNumber();
  const vaultTopic = zeroPadValue(vault, 32);
  const guardLogs = await getLogsChunked(provider, { address: guard, topics: [null, vaultTopic] }, fromBlock, to, chunk);
  const vaultLogs = await getLogsChunked(provider, { address: vault }, fromBlock, to, chunk);

  const decoded = [];
  for (const [logs, iface] of [[guardLogs, guardInterface], [vaultLogs, vaultInterface]]) {
    for (const log of logs) {
      let parsed;
      try { parsed = iface.parseLog(log); } catch { continue; }
      if (parsed) {
        decoded.push({
          name: parsed.name, blockNumber: log.blockNumber, logIndex: log.index, txHash: log.transactionHash,
          args: parsed.args
        });
      }
    }
  }
  // One block lookup per distinct block that holds an event.
  const times = new Map();
  for (const blockNumber of new Set(decoded.map((e) => e.blockNumber))) {
    times.set(blockNumber, (await provider.getBlock(blockNumber)).timestamp);
  }
  for (const e of decoded) e.time = times.get(e.blockNumber);

  const guardContract = new Contract(guard, GUARD_ABI, provider);
  const vaultContract = new Contract(vault, VAULT_ABI, provider);
  const [limits, state, freeze, assetAddress] = await Promise.all([
    guardContract.limitsOf(vault),
    vaultContract.state(),
    guardContract.freezeOf(vault),
    vaultContract.asset()
  ]);
  const decimals = Number(await new Contract(assetAddress, ERC20_ABI, provider).decimals());

  return {
    vault, guard, fromBlock, toBlock: to,
    ...summarize(decoded, {
      limits: { maxDrawdownBps: limits.maxDrawdownBps },
      state, freeze: { reason: freeze.reason, frozenAt: freeze.frozenAt }, decimals
    }, { maxPoints })
  };
}

// Clipping and statistics for the performance CI (mandate-technical-spec-v0.2.md
// 4.2): "거래별 return contribution을 [-c, c]로 clipping. epoch별 mean return,
// Sharpe, realized/max marked drawdown의 DP 통계를 계산한다."

export function clip(value, bound) {
  if (value > bound) return bound;
  if (value < -bound) return -bound;
  return value;
}

export function mean(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function sharpe(returns) {
  const sd = stdDev(returns);
  return sd === 0 ? 0 : mean(returns) / sd;
}

/// Largest peak-to-trough fractional decline of a NAV-per-share series. This is
/// the *marked* drawdown the stats release reports -- a different number from
/// RiskGuard's own high-water drawdown, which is enforced live onchain, not
/// released as a DP statistic.
export function maxDrawdown(navSeries) {
  let peak = -Infinity;
  let worst = 0;
  for (const nav of navSeries) {
    if (nav > peak) peak = nav;
    const drawdown = peak > 0 ? (peak - nav) / peak : 0;
    if (drawdown > worst) worst = drawdown;
  }
  return worst;
}

/// Per-step returns implied by a NAV-per-share series -- the shape a RiskGuard's
/// `Marked` event history already comes in (web/app.js's `state.navSeries`).
/// Lets a caller feed buildRelease() straight from chain-scanned marks instead
/// of pre-computing returns itself.
export function returnsFromNavSeries(navSeries) {
  const returns = [];
  for (let i = 1; i < navSeries.length; i++) {
    const previous = navSeries[i - 1];
    if (previous === 0) continue;
    returns.push(navSeries[i] / previous - 1);
  }
  return returns;
}

/// Laplace scale for the mean of `sampleSize` values each clipped to
/// [-clipBound, clipBound]. Changing one record can move the sum by at most
/// 2*clipBound (from -clipBound to +clipBound), so the mean's global
/// sensitivity is 2*clipBound/sampleSize, and the report-noisy-mean mechanism's
/// scale is sensitivity/epsilon.
export function laplaceScaleForMean(clipBound, sampleSize, epsilon) {
  if (sampleSize === 0 || epsilon === 0) return Infinity;
  return (2 * clipBound) / (sampleSize * epsilon);
}

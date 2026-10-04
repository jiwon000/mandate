// The "Privacy Simulator" (mandate-technical-spec-v0.2.md 4.4): an educational
// tool showing how epsilon trades off against confidence-interval width.
// Deliberately separated from reporter.mjs/epsilon.mjs at the file level: this
// module never imports EpsilonLedger, never sees reporterSecret, and never
// signs anything, so moving its slider cannot consume real privacy budget or
// produce something postable to MandateRegistry. It reuses the real Reporter's
// own laplaceScaleForMean() so the picture it draws is never mathematically
// inconsistent with an actual release -- only the input numbers are synthetic.
import { laplaceScaleForMean } from "./stats.mjs";

/// 95% two-sided confidence interval for a Laplace(0, scale) noise term:
/// P(-h < X < h) = 1 - exp(-h/scale) = 0.95  =>  h = scale * ln(20).
const NINETY_FIVE_PERCENT_Z = Math.log(20);

export function simulateConfidenceInterval({ meanEstimate, clipBound, sampleSize, epsilon }) {
  const scale = laplaceScaleForMean(clipBound, sampleSize, epsilon);
  const halfWidth = scale * NINETY_FIVE_PERCENT_Z;
  return {
    scale,
    halfWidth,
    ciLow: meanEstimate - halfWidth,
    ciHigh: meanEstimate + halfWidth
  };
}

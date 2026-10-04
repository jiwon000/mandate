// Deterministic noise derivation for DP releases
// (mandate-technical-spec-v0.2.md 4.3). The seed is a keyed HMAC so nobody
// without reporterSecret can predict or recompute the actual noise, but the
// same (secret, domain, epoch, pinnedBlock, statsVersion) tuple always
// reproduces the exact same release internally -- that reproducibility is
// what lets a release be regenerated and checked against its statsDigest,
// without ever exposing reporterSecret or letting an outsider forge one.
import { createHash, createHmac } from "node:crypto";

/// seed = HMAC_SHA256(reporterSecret, domainSeparator || epochId || pinnedBlock || statsVersion)
export function deriveSeed(reporterSecret, { domainSeparator, epochId, pinnedBlock, statsVersion }) {
  const material = `${domainSeparator}|${epochId}|${pinnedBlock}|${statsVersion}`;
  return createHmac("sha256", reporterSecret).update(material).digest();
}

/// A deterministic, non-cryptographic uniform(0,1) stream derived from `seed`.
/// Not for key material -- only for reproducible statistical sampling. Each
/// draw rehashes seed||counter, so the stream never repeats within a release
/// (2^32 draws per seed, far past anything one release needs).
function* uniformStream(seed) {
  let counter = 0;
  while (true) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const digest = createHash("sha256").update(seed).update(counterBytes).digest();
    // 6 bytes (48 bits) of precision, read big-endian so every bit of the hash
    // output contributes -- ample for a Laplace sample and free of the bias a
    // narrower read could introduce at the distribution's edges.
    yield digest.readUIntBE(0, 6) / 2 ** 48;
    counter += 1;
  }
}

/// `count` iid samples from Laplace(0, scale) via inverse-CDF transform of a
/// seeded uniform stream: F^-1(u) = -scale * sign(u) * ln(1 - 2|u|) for u in (-0.5, 0.5).
export function laplaceSamples(seed, count, scale) {
  const stream = uniformStream(seed);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const u = stream.next().value - 0.5;
    samples.push(-scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)));
  }
  return samples;
}

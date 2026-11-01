// Claimed-token attribution shared by snapshots, UI, and CSV exports.
// Raw LP/Hold can exceed claimed when wallets acquire tokens elsewhere, so
// attribution is applied per wallet before aggregation.

/**
 * Attribute one wallet's claimed tokens across current LP, Hold, and Outflow.
 *
 * Retained claims are capped at claimed and split proportionally across the
 * wallet's current LP:Hold exposure. The final wei remainder is assigned to
 * Hold so attributed LP + attributed Hold + Outflow equals claimed exactly.
 */
export function attributeClaimed(row) {
  const claimed = row.claimed > 0n ? row.claimed : 0n;
  const rawLp = row.lp > 0n ? row.lp : 0n;
  const rawHold = row.hold > 0n ? row.hold : 0n;
  const exposure = rawLp + rawHold;
  const retained = exposure < claimed ? exposure : claimed;
  const attributedOutflow = claimed - retained;
  const attributedLp = exposure > 0n ? (retained * rawLp) / exposure : 0n;
  const attributedHold = retained - attributedLp;
  const excessExposure = exposure > claimed ? exposure - claimed : 0n;
  return {
    attributedLp, attributedHold, attributedOutflow,
    retained, excessExposure,
  };
}

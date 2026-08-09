// Uniswap-V3 / Aerodrome-Slipstream concentrated-liquidity math in exact
// BigInt arithmetic — integer-for-integer port of v3math.go. Computes a
// position's token amounts from its liquidity, tick range and pool price.

export const Q96 = 1n << 96n;
const Q32 = 1n << 32n;
const UINT256_MAX = (1n << 256n) - 1n;

// Precomputed multipliers from Uniswap V3 TickMath.
const TICK_CONSTANTS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x09aa508b5b7a84e1c677de54f3e99bc9n,
  0x005d6af8dedb81196699c329225ee604n,
  0x002216e584f5fa1ea926041bedfe98n,
  0x000048a170391f7dc42444e8fa2n,
];

/**
 * sqrt(1.0001^tick) as a Q64.96 fixed-point BigInt, matching Uniswap V3
 * TickMath.getSqrtRatioAtTick exactly.
 */
export function getSqrtRatioAtTick(tick) {
  const abs = tick < 0 ? -tick : tick;

  let ratio = (abs & 0x1) !== 0 ? TICK_CONSTANTS[0] : (1n << 128n);
  let mask = 0x2;
  for (let i = 1; i < TICK_CONSTANTS.length; i++) {
    if ((abs & mask) !== 0) {
      ratio = (ratio * TICK_CONSTANTS[i]) >> 128n;
    }
    mask <<= 1;
  }

  if (tick > 0) ratio = UINT256_MAX / ratio;

  // sqrtPriceX96 = (ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)
  let out = ratio >> 32n;
  if (ratio % Q32 !== 0n) out += 1n;
  return out;
}

/** amount0 = L * 2^96 * (sqrtB - sqrtA) / (sqrtB * sqrtA), for sqrtA < sqrtB. */
function getAmount0(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const den = sqrtB * sqrtA;
  if (den === 0n) return 0n;
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / den;
}

/** amount1 = L * (sqrtB - sqrtA) / 2^96, for sqrtA < sqrtB. */
function getAmount1(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/**
 * (amount0, amount1) for a position with the given liquidity and tick range,
 * evaluated at the pool's current sqrtPriceX96.
 */
export function positionAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 <= sqrtA) {
    // Entirely below range -> all token0.
    amount0 = getAmount0(sqrtA, sqrtB, liquidity);
  } else if (sqrtPriceX96 < sqrtB) {
    // In range.
    amount0 = getAmount0(sqrtPriceX96, sqrtB, liquidity);
    amount1 = getAmount1(sqrtA, sqrtPriceX96, liquidity);
  } else {
    // Entirely above range -> all token1.
    amount1 = getAmount1(sqrtA, sqrtB, liquidity);
  }
  return [amount0, amount1];
}

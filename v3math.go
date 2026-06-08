package main

import (
	"math/big"
)

// Uniswap-V3 / Aerodrome-Slipstream concentrated-liquidity math, in exact
// integer arithmetic (big.Int), used to compute a position's token amounts from
// its liquidity, tick range and the pool's current price.
//
// AORA_LP for a wallet = Σ over its positions in the AORA pool of the AORA-side
// token amount (amount0 if AORA is token0, else amount1).

var (
	q96      = new(big.Int).Lsh(big.NewInt(1), 96)  // 2^96
	q32      = new(big.Int).Lsh(big.NewInt(1), 32)  // 2^32
	uint256Max = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
)

// tickMathConstants are the precomputed multipliers from Uniswap V3 TickMath.
var tickMathConstants = []string{
	"fffcb933bd6fad37aa2d162d1a594001",
	"fff97272373d413259a46990580e213a",
	"fff2e50f5f656932ef12357cf3c7fdcc",
	"ffe5caca7e10e4e61c3624eaa0941cd0",
	"ffcb9843d60f6159c9db58835c926644",
	"ff973b41fa98c081472e6896dfb254c0",
	"ff2ea16466c96a3843ec78b326b52861",
	"fe5dee046a99a2a811c461f1969c3053",
	"fcbe86c7900a88aedcffc83b479aa3a4",
	"f987a7253ac413176f2b074cf7815e54",
	"f3392b0822b70005940c7a398e4b70f3",
	"e7159475a2c29b7443b29c7fa6e889d9",
	"d097f3bdfd2022b8845ad8f792aa5825",
	"a9f746462d870fdf8a65dc1f90e061e5",
	"70d869a156d2a1b890bb3df62baf32f7",
	"31be135f97d08fd981231505542fcfa6",
	"09aa508b5b7a84e1c677de54f3e99bc9",
	"005d6af8dedb81196699c329225ee604",
	"002216e584f5fa1ea926041bedfe98",
	"000048a170391f7dc42444e8fa2",
}

func hexBig(s string) *big.Int {
	v, _ := new(big.Int).SetString(s, 16)
	return v
}

// GetSqrtRatioAtTick returns sqrt(1.0001^tick) as a Q64.96 fixed-point number,
// matching Uniswap V3 TickMath.getSqrtRatioAtTick exactly.
func GetSqrtRatioAtTick(tick int) *big.Int {
	abs := tick
	if abs < 0 {
		abs = -abs
	}
	absU := uint(abs)

	ratio := new(big.Int)
	if absU&0x1 != 0 {
		ratio.Set(hexBig(tickMathConstants[0]))
	} else {
		ratio.Set(new(big.Int).Lsh(big.NewInt(1), 128)) // 0x1 << 128
	}
	mask := uint(0x2)
	for i := 1; i < len(tickMathConstants); i++ {
		if absU&mask != 0 {
			ratio.Mul(ratio, hexBig(tickMathConstants[i]))
			ratio.Rsh(ratio, 128)
		}
		mask <<= 1
	}

	if tick > 0 {
		ratio.Div(uint256Max, ratio)
	}

	// sqrtPriceX96 = (ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)
	out := new(big.Int).Rsh(ratio, 32)
	rem := new(big.Int).Mod(ratio, q32)
	if rem.Sign() != 0 {
		out.Add(out, big.NewInt(1))
	}
	return out
}

// getAmount0 = L * 2^96 * (sqrtB - sqrtA) / (sqrtB * sqrtA), for sqrtA < sqrtB.
func getAmount0(sqrtA, sqrtB, liquidity *big.Int) *big.Int {
	if sqrtA.Cmp(sqrtB) > 0 {
		sqrtA, sqrtB = sqrtB, sqrtA
	}
	num := new(big.Int).Mul(new(big.Int).Lsh(liquidity, 96), new(big.Int).Sub(sqrtB, sqrtA))
	den := new(big.Int).Mul(sqrtB, sqrtA)
	if den.Sign() == 0 {
		return new(big.Int)
	}
	return num.Div(num, den)
}

// getAmount1 = L * (sqrtB - sqrtA) / 2^96, for sqrtA < sqrtB.
func getAmount1(sqrtA, sqrtB, liquidity *big.Int) *big.Int {
	if sqrtA.Cmp(sqrtB) > 0 {
		sqrtA, sqrtB = sqrtB, sqrtA
	}
	num := new(big.Int).Mul(liquidity, new(big.Int).Sub(sqrtB, sqrtA))
	return num.Div(num, q96)
}

// PositionAmounts returns (amount0, amount1) for a position with the given
// liquidity and tick range, evaluated at the pool's current sqrtPriceX96.
func PositionAmounts(sqrtPriceX96 *big.Int, tickLower, tickUpper int, liquidity *big.Int) (*big.Int, *big.Int) {
	sqrtA := GetSqrtRatioAtTick(tickLower)
	sqrtB := GetSqrtRatioAtTick(tickUpper)
	amount0 := new(big.Int)
	amount1 := new(big.Int)
	switch {
	case sqrtPriceX96.Cmp(sqrtA) <= 0:
		// Entirely below range -> all token0.
		amount0 = getAmount0(sqrtA, sqrtB, liquidity)
	case sqrtPriceX96.Cmp(sqrtB) < 0:
		// In range.
		amount0 = getAmount0(sqrtPriceX96, sqrtB, liquidity)
		amount1 = getAmount1(sqrtA, sqrtPriceX96, liquidity)
	default:
		// Entirely above range -> all token1.
		amount1 = getAmount1(sqrtA, sqrtB, liquidity)
	}
	return amount0, amount1
}

// signedTick decodes a 32-byte ABI word holding an int24 (two's complement).
func signedTick(word string) int {
	v := hexToBig("0x" + word)
	// int24 sign bit is bit 23; values are stored sign-extended to 256 bits, so
	// a value >= 2^255 means negative.
	half := new(big.Int).Lsh(big.NewInt(1), 255)
	if v.Cmp(half) >= 0 {
		v = new(big.Int).Sub(v, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return int(v.Int64())
}

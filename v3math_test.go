package main

import "testing"

func TestSqrtRatioKnown(t *testing.T) {
	// tick 0 -> 2^96 (canonical Uniswap V3 TickMath check).
	if got := GetSqrtRatioAtTick(0); got.Cmp(q96) != 0 {
		t.Errorf("tick0 = %s want %s", got, q96)
	}
}

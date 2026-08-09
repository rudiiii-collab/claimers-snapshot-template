package main

// Oracle: prints reference values from the Go implementation so the JS port
// (web/) can be verified value-for-value. The expected constants in
// web/test/run-tests.mjs were generated from this output.
// Run: go test -run TestOracle -v

import (
	"fmt"
	"math/big"
	"testing"
)

func TestOracle(t *testing.T) {
	fmt.Println("== topics ==")
	fmt.Println("ClaimRewards", topicClaimRewards)
	fmt.Println("PoolCreated ", topicPoolCreated)
	fmt.Println("aggregate3  ", selAggregate3)
	fmt.Println("slot0       ", selSlot0)
	fmt.Println("stakedValues", selStakedValues)
	fmt.Println("positions   ", selPositions)
	fmt.Println("gauges      ", selGauges)
	fmt.Println("tokenOfOwner", selTokenOfOwner)

	fmt.Println("== sqrtRatioAtTick ==")
	for _, tick := range []int{-887272, -100000, -50000, -200, -1, 0, 1, 200, 50000, 100000, 887272} {
		fmt.Printf("tick %d = %s\n", tick, GetSqrtRatioAtTick(tick))
	}

	fmt.Println("== positionAmounts ==")
	// A realistic Slipstream case: price between ticks.
	sqrtP := GetSqrtRatioAtTick(12345)
	liq, _ := new(big.Int).SetString("123456789012345678901234", 10)
	cases := [][2]int{{-887200, 887200}, {12000, 13000}, {-50000, 12000}, {12400, 20000}}
	for _, c := range cases {
		a0, a1 := PositionAmounts(sqrtP, c[0], c[1], liq)
		fmt.Printf("pos [%d,%d] a0=%s a1=%s\n", c[0], c[1], a0, a1)
	}

	fmt.Println("== encodeAggregate3 ==")
	calls := []Call3{
		{Target: defAoraToken, Data: callDataBalanceOf("0x28aa4f9ffe21365473b64c161b566c3cdead0108")},
		{Target: defPool, Data: selSlot0},
	}
	fmt.Println(encodeAggregate3(calls))
}

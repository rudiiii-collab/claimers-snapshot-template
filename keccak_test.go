package main

import "testing"

func TestKnownSelectorsAndTopics(t *testing.T) {
	cases := map[string]string{
		selector("balanceOf(address)"):                              "0x70a08231",
		selector("totalSupply()"):                                   "0x18160ddd",
		selector("decimals()"):                                      "0x313ce567",
		selector("symbol()"):                                        "0x95d89b41",
		selector("token0()"):                                        "0x0dfe1681",
		selector("token1()"):                                        "0xd21220a7",
		selector("getReserves()"):                                   "0x0902f1ac",
		topic0("Transfer(address,address,uint256)"):                 "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
		topic0("Approval(address,address,uint256)"):                 "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("got %s want %s", got, want)
		}
	}
	if selAggregate3 != "0x82ad56cb" {
		t.Errorf("aggregate3 selector = %s want 0x82ad56cb", selAggregate3)
	}
	// Print the derived signatures we depend on for manual cross-check.
	t.Logf("ClaimRewards topic0 = %s", topicClaimRewards)
	t.Logf("PoolCreated  topic0 = %s", topicPoolCreated)
}

// TestEncodeAggregate3 pins the calldata for a single balanceOf sub-call against
// a hand-computed expectation, so the dynamic ABI offsets are exactly right.
func TestEncodeAggregate3(t *testing.T) {
	wallet := "0x28aa4f9ffe21365473b64c161b566c3cdead0108"
	calls := []Call3{{Target: defAoraToken, Data: callDataBalanceOf(wallet)}}

	inner := strip0x(callDataBalanceOf(wallet)) // 36 bytes = 72 hex chars
	if len(inner) != 72 {
		t.Fatalf("balanceOf calldata len = %d hex chars", len(inner))
	}
	paddedData := inner + "00000000000000000000000000000000000000000000000000000000" // pad to 128
	tail0 := encAddress(defAoraToken) + wordUint(1) + wordUint(0x60) + wordUint(36) + paddedData
	arrayBody := wordUint(1) + wordUint(0x20) + tail0
	want := selAggregate3 + wordUint(0x20) + arrayBody

	if got := encodeAggregate3(calls); got != want {
		t.Errorf("encodeAggregate3 mismatch:\n got=%s\nwant=%s", got, want)
	}
}

// TestDecodeAggregate3 builds a Result[] = [(true, <32-byte 0x..2a>), (false, "")]
// payload by hand and checks the decoder reads it back.
func TestDecodeAggregate3(t *testing.T) {
	val := wordUint(42) // 32-byte return for the first call
	// Result tuple (bool success, bytes data) has 2 head words => bytesOffset=0x40.
	elem0 := wordUint(1) + wordUint(0x40) + wordUint(32) + val
	elem1 := wordUint(0) + wordUint(0x40) + wordUint(0)
	headArea := wordUint(0x40) + wordUint(0x40+len(elem0)/2) // offsets relative to after length
	array := wordUint(2) + headArea + elem0 + elem1
	payload := "0x" + wordUint(0x20) + array

	res, err := decodeAggregate3(payload)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("got %d results want 2", len(res))
	}
	if !res[0].Success || resultUint(res[0]).Int64() != 42 {
		t.Errorf("elem0 = %+v (val=%d)", res[0], resultUint(res[0]).Int64())
	}
	if res[1].Success || resultUint(res[1]).Sign() != 0 {
		t.Errorf("elem1 = %+v want failure/zero", res[1])
	}
}

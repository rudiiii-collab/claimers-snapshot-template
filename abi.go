package main

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
)

// Minimal ABI helpers. We compute selectors and event topics from their
// signatures via Keccak-256 so nothing is a guessed magic number.

func selector(sig string) string {
	h := Keccak256([]byte(sig))
	return "0x" + hex.EncodeToString(h[:4])
}

func topic0(sig string) string {
	h := Keccak256([]byte(sig))
	return "0x" + hex.EncodeToString(h[:])
}

// Cached signatures (Dune-equivalent: aerodrome_base.votingreward_evt_claimrewards).
var (
	selBalanceOf   = selector("balanceOf(address)")
	selTotalSupply = selector("totalSupply()")
	selDecimals    = selector("decimals()")
	selSymbol      = selector("symbol()")
	selToken0      = selector("token0()")
	selToken1      = selector("token1()")
	selGetReserves = selector("getReserves()")

	// Velodrome/Aerodrome Reward.sol (verified on-chain — BOTH address args are
	// indexed, so the layout is: topic0=sig, topic1=from, topic2=reward, and
	// data[0]=amount):
	//   event ClaimRewards(address indexed from, address indexed reward, uint256 amount);
	topicClaimRewards = topic0("ClaimRewards(address,address,uint256)")

	// Aerodrome PoolFactory:
	//   event PoolCreated(address indexed token0, address indexed token1,
	//                     bool indexed stable, address pool, uint256 length);
	topicPoolCreated = topic0("PoolCreated(address,address,bool,address,uint256)")
)

// encAddress left-pads a 20-byte address to a 32-byte ABI word.
func encAddress(addr string) string {
	a := strings.ToLower(strings.TrimPrefix(addr, "0x"))
	return strings.Repeat("0", 64-len(a)) + a
}

// callDataBalanceOf builds calldata for balanceOf(address).
func callDataBalanceOf(wallet string) string { return selBalanceOf + encAddress(wallet) }

// addressTopic left-pads an address into a 32-byte topic value for log filtering.
func addressTopic(addr string) string { return "0x" + encAddress(addr) }

// topicToAddress extracts a 20-byte address from a 32-byte indexed topic word.
func topicToAddress(topic string) string {
	t := strings.TrimPrefix(topic, "0x")
	if len(t) < 40 {
		return "0x" + t
	}
	return "0x" + t[len(t)-40:]
}

// returnAddress reads the address from a single-word eth_call return.
func returnAddress(ret string) string {
	r := strings.TrimPrefix(ret, "0x")
	if len(r) < 40 {
		return ""
	}
	return "0x" + strings.ToLower(r[len(r)-40:])
}

// returnUint reads the first 32-byte word as a big integer.
func returnUint(ret string) *big.Int {
	r := strings.TrimPrefix(ret, "0x")
	if len(r) < 64 {
		return hexToBig(ret)
	}
	return hexToBig("0x" + r[:64])
}

// dataWords splits 0x-hex data into 32-byte words.
func dataWords(data string) []string {
	d := strings.TrimPrefix(data, "0x")
	var words []string
	for i := 0; i+64 <= len(d); i += 64 {
		words = append(words, d[i:i+64])
	}
	return words
}

// Reserves holds the first two getReserves() outputs.
type Reserves struct {
	Reserve0 *big.Int
	Reserve1 *big.Int
}

func parseReserves(ret string) (Reserves, error) {
	w := dataWords(ret)
	if len(w) < 2 {
		return Reserves{}, fmt.Errorf("getReserves: short return %q", ret)
	}
	return Reserves{
		Reserve0: hexToBig("0x" + w[0]),
		Reserve1: hexToBig("0x" + w[1]),
	}, nil
}

// decodeString decodes an ABI-encoded dynamic string return (offset,len,bytes).
func decodeString(ret string) string {
	w := dataWords(ret)
	if len(w) < 2 {
		return ""
	}
	length := hexToBig("0x" + w[1]).Int64()
	raw := strings.TrimPrefix(ret, "0x")
	start := 64 * 2 // after offset+length words
	end := start + int(length)*2
	if end > len(raw) {
		end = len(raw)
	}
	b, _ := hex.DecodeString(raw[start:end])
	return string(b)
}

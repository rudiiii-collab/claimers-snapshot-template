package main

import (
	"fmt"
	"strings"
)

// Multicall3 is deployed at the same canonical address on Base (and most chains).
// aggregate3 performs many staticcalls in one call; invoked via eth_call with a
// historical block tag it evaluates every sub-call against that block's state,
// so a whole snapshot block collapses into a handful of RPC requests instead of
// one per wallet.
const Multicall3Addr = "0xca11bde05977b3631167028862be2a173976ca11"

// aggregate3((address,bool,bytes)[]) selector, derived from the signature.
var selAggregate3 = selector("aggregate3((address,bool,bytes)[])")

// Call3 is one Multicall3 sub-call. Data is 0x-hex (or bare hex) calldata.
type Call3 struct {
	Target string
	Data   string
}

// CallResult is one decoded sub-call result. Ret is 0x-hex return data.
type CallResult struct {
	Success bool
	Ret     string
}

func strip0x(s string) string { return strings.TrimPrefix(strings.ToLower(s), "0x") }

func wordUint(v int) string {
	return fmt.Sprintf("%064x", v)
}

// encodeAggregate3 ABI-encodes a Call3[] (every call uses allowFailure=true so a
// single reverting sub-call never aborts the whole batch).
func encodeAggregate3(calls []Call3) string {
	n := len(calls)

	tails := make([]string, n)
	for i, c := range calls {
		data := strip0x(c.Data)
		if rem := len(data) % 64; rem != 0 {
			data += strings.Repeat("0", 64-rem)
		}
		dataLenBytes := len(strip0x(c.Data)) / 2
		// tuple: address, allowFailure(=1), offset-to-bytes(=0x60), len, bytes...
		tails[i] = encAddress(c.Target) + wordUint(1) + wordUint(0x60) + wordUint(dataLenBytes) + data
	}

	// Head: n offset words (relative to start of data after the length word).
	var heads strings.Builder
	off := n * 32
	for i := 0; i < n; i++ {
		heads.WriteString(wordUint(off))
		off += len(tails[i]) / 2
	}

	arrayBody := wordUint(n) + heads.String() + strings.Join(tails, "")
	// Top-level: single dynamic arg, offset 0x20.
	return selAggregate3 + wordUint(0x20) + arrayBody
}

func wordAt(h string, byteOff int) (string, bool) {
	start := byteOff * 2
	if start+64 > len(h) {
		return "", false
	}
	return h[start : start+64], true
}

func hexUintAt(h string, byteOff int) (int, bool) {
	w, ok := wordAt(h, byteOff)
	if !ok {
		return 0, false
	}
	return int(hexToBig("0x" + w).Int64()), true
}

// decodeAggregate3 decodes the Result[] (bool success, bytes returnData)[].
func decodeAggregate3(ret string) ([]CallResult, error) {
	h := strip0x(ret)
	arrOff, ok := hexUintAt(h, 0)
	if !ok {
		return nil, fmt.Errorf("multicall: short return")
	}
	n, ok := hexUintAt(h, arrOff)
	if !ok {
		return nil, fmt.Errorf("multicall: bad array length")
	}
	dataStart := arrOff + 32 // element head offsets are relative to here
	out := make([]CallResult, 0, n)
	for i := 0; i < n; i++ {
		elemOff, ok := hexUintAt(h, dataStart+i*32)
		if !ok {
			return nil, fmt.Errorf("multicall: bad element offset %d", i)
		}
		elemStart := dataStart + elemOff
		succWord, ok := wordAt(h, elemStart)
		if !ok {
			return nil, fmt.Errorf("multicall: bad success word %d", i)
		}
		success := hexToBig("0x"+succWord).Sign() != 0
		bytesOff, ok := hexUintAt(h, elemStart+32)
		if !ok {
			return nil, fmt.Errorf("multicall: bad bytes offset %d", i)
		}
		lenPos := elemStart + bytesOff
		blen, ok := hexUintAt(h, lenPos)
		if !ok {
			return nil, fmt.Errorf("multicall: bad bytes len %d", i)
		}
		dataPos := (lenPos + 32) * 2
		end := dataPos + blen*2
		if end > len(h) {
			end = len(h)
		}
		retData := ""
		if dataPos <= len(h) {
			retData = "0x" + h[dataPos:end]
		}
		out = append(out, CallResult{Success: success, Ret: retData})
	}
	return out, nil
}

// MultiCall executes calls via Multicall3 at the given block, automatically
// chunking into batches of batchSize and preserving overall order.
func (c *Client) MultiCall(calls []Call3, block uint64, batchSize int) ([]CallResult, error) {
	if batchSize <= 0 {
		batchSize = 500
	}
	results := make([]CallResult, 0, len(calls))
	for i := 0; i < len(calls); i += batchSize {
		j := i + batchSize
		if j > len(calls) {
			j = len(calls)
		}
		data := encodeAggregate3(calls[i:j])
		ret, err := c.EthCall(Multicall3Addr, data, block)
		if err != nil {
			return nil, fmt.Errorf("multicall [%d,%d) @%d: %w", i, j, block, err)
		}
		decoded, err := decodeAggregate3(ret)
		if err != nil {
			return nil, fmt.Errorf("multicall decode [%d,%d) @%d: %w", i, j, block, err)
		}
		if len(decoded) != j-i {
			return nil, fmt.Errorf("multicall [%d,%d): expected %d results got %d", i, j, j-i, len(decoded))
		}
		results = append(results, decoded...)
	}
	return results, nil
}

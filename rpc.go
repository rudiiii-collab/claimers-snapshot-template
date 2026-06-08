package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Client is a minimal, rate-limited, retrying JSON-RPC client.
type Client struct {
	url        string
	http       *http.Client
	ticker     *time.Ticker
	maxRetries int
	id         int
}

func NewClient(url string, ratePerSecond float64, maxRetries int) *Client {
	if ratePerSecond <= 0 {
		ratePerSecond = 8
	}
	interval := time.Duration(float64(time.Second) / ratePerSecond)
	return &Client{
		url:        url,
		http:       &http.Client{Timeout: 60 * time.Second},
		ticker:     time.NewTicker(interval),
		maxRetries: maxRetries,
	}
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResp struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// call performs a single JSON-RPC request with rate limiting + exponential backoff.
func (c *Client) call(method string, params ...any) (json.RawMessage, error) {
	c.id++
	body, _ := json.Marshal(rpcReq{JSONRPC: "2.0", ID: c.id, Method: method, Params: params})

	var lastErr error
	backoff := 500 * time.Millisecond
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		<-c.ticker.C // rate limit

		req, _ := http.NewRequest("POST", c.url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
		} else {
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 429 || resp.StatusCode >= 500 {
				lastErr = fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
			} else {
				var out rpcResp
				if err := json.Unmarshal(raw, &out); err != nil {
					lastErr = fmt.Errorf("decode: %w (body=%s)", err, truncate(string(raw), 200))
				} else if out.Error != nil {
					// Retry transient rate/limit errors; fail fast on the rest.
					if isRetryable(out.Error.Message) {
						lastErr = out.Error
					} else {
						return nil, out.Error
					}
				} else {
					return out.Result, nil
				}
			}
		}
		if attempt < c.maxRetries {
			log.Printf("rpc %s retry %d/%d after %v: %v", method, attempt+1, c.maxRetries, backoff, lastErr)
			time.Sleep(backoff)
			if backoff < 16*time.Second {
				backoff *= 2
			}
		}
	}
	return nil, fmt.Errorf("rpc %s failed after %d retries: %w", method, c.maxRetries, lastErr)
}

// isRangeError detects "eth_getLogs block range too large" style errors that
// many providers (e.g. Alchemy free tier: 10-block cap) return.
func isRangeError(err error) bool {
	if err == nil {
		return false
	}
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "block range") ||
		strings.Contains(m, "range should work") ||
		strings.Contains(m, "query returned more than") ||
		strings.Contains(m, "logs matched") ||
		strings.Contains(m, "too many results") ||
		strings.Contains(m, "response size")
}

// parseSuggestedRange pulls a provider-suggested working range out of an error
// like "...should work: [0x2aea540, 0x2aea549]" and returns its block span.
func parseSuggestedRange(errMsg string) (uint64, bool) {
	re := regexp.MustCompile(`0x[0-9a-fA-F]+`)
	ms := re.FindAllString(errMsg, -1)
	if len(ms) >= 2 {
		a := hexToUint64(ms[len(ms)-2])
		b := hexToUint64(ms[len(ms)-1])
		if b >= a {
			return b - a + 1, true
		}
	}
	return 0, false
}

func isRetryable(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{"rate", "limit", "timeout", "busy", "capacity", "try again", "429"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// BlockNumber returns the current head block.
func (c *Client) BlockNumber() (uint64, error) {
	raw, err := c.call("eth_blockNumber")
	if err != nil {
		return 0, err
	}
	var hex string
	if err := json.Unmarshal(raw, &hex); err != nil {
		return 0, err
	}
	return hexToUint64(hex), nil
}

// EthCall executes a read-only call at the given block (decimal). data is 0x-hex.
func (c *Client) EthCall(to, data string, block uint64) (string, error) {
	tag := blockTag(block)
	raw, err := c.call("eth_call", map[string]string{"to": to, "data": data}, tag)
	if err != nil {
		return "", err
	}
	var hex string
	if err := json.Unmarshal(raw, &hex); err != nil {
		return "", err
	}
	return hex, nil
}

// Log is a decoded eth log.
type Log struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
}

// GetLogs fetches logs for [from,to] (inclusive) for one address + topic filter.
// topics may contain "" entries (wildcard) or a single value per position.
func (c *Client) GetLogs(address string, fromBlock, toBlock uint64, topics []any) ([]Log, error) {
	filter := map[string]any{
		"fromBlock": blockTag(fromBlock),
		"toBlock":   blockTag(toBlock),
	}
	if address != "" {
		filter["address"] = address
	}
	if len(topics) > 0 {
		filter["topics"] = topics
	}
	raw, err := c.call("eth_getLogs", filter)
	if err != nil {
		return nil, err
	}
	var logs []Log
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// BlockTimestamp returns the unix timestamp of a block.
func (c *Client) BlockTimestamp(block uint64) (uint64, error) {
	raw, err := c.call("eth_getBlockByNumber", blockTag(block), false)
	if err != nil {
		return 0, err
	}
	var b struct {
		Timestamp string `json:"timestamp"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return 0, err
	}
	return hexToUint64(b.Timestamp), nil
}

// ---- hex helpers ----

func blockTag(n uint64) string { return fmt.Sprintf("0x%x", n) }

func hexToUint64(h string) uint64 {
	h = strings.TrimPrefix(h, "0x")
	if h == "" {
		return 0
	}
	v := new(big.Int)
	v.SetString(h, 16)
	return v.Uint64()
}

func hexToBig(h string) *big.Int {
	h = strings.TrimPrefix(h, "0x")
	v := new(big.Int)
	if h == "" {
		return v
	}
	v.SetString(h, 16)
	return v
}

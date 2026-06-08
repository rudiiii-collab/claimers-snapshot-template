package main

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"
)

// Pool describes an Aerodrome pool that holds AORA.
type Pool struct {
	Address      string
	Token0       string
	Token1       string
	Stable       string // "true"/"false"/"" if unknown
	AoraIsToken0 bool
}

func poolsPath(cfg *Config) string { return filepath.Join(cfg.OutDir, "pools.csv") }

// DiscoverPools finds Aerodrome pools containing AORA by scanning PoolCreated
// events from the factory (AORA as token0 OR token1). If cfg.Pools is set, those
// addresses are used directly instead (token ordering is resolved via eth_call).
func DiscoverPools(c *Client, cfg *Config) ([]Pool, error) {
	if len(cfg.Pools) > 0 {
		log.Printf("using %d manual pool(s) from POOLS", len(cfg.Pools))
		return resolveManualPools(c, cfg)
	}

	end := cfg.EndBlock
	if end == 0 {
		h, err := c.BlockNumber()
		if err != nil {
			return nil, err
		}
		end = h
	}
	start := cfg.StartBlock
	aoraTopic := "0x" + encAddress(cfg.AoraToken)
	log.Printf("scanning PoolCreated on factory %s [%d,%d] (topic0=%s)",
		cfg.Factory, start, end, topicPoolCreated)

	seen := map[string]bool{}
	var pools []Pool
	chunk := cfg.ChunkBlocks
	if chunk == 0 {
		chunk = 2000
	}

	// Two passes: AORA at indexed token0 position, then token1 position.
	filters := [][]any{
		{topicPoolCreated, aoraTopic},        // token0 == AORA
		{topicPoolCreated, nil, aoraTopic},   // token1 == AORA
	}
	for _, topics := range filters {
		for from := start; from <= end; {
			to := from + chunk - 1
			if to > end {
				to = end
			}
			logs, err := c.GetLogs(cfg.Factory, from, to, topics)
			if err != nil {
				if isRangeError(err) {
					nc, ok := parseSuggestedRange(err.Error())
					if !ok || nc == 0 || nc >= chunk {
						nc = chunk / 2
					}
					if nc < 1 {
						nc = 1
					}
					log.Printf("provider rejected %d-block range; shrinking to %d", chunk, nc)
					chunk = nc
					continue
				}
				return nil, fmt.Errorf("PoolCreated getLogs [%d,%d]: %w", from, to, err)
			}
			from = to + 1
			for _, lg := range logs {
				if len(lg.Topics) < 4 {
					continue
				}
				token0 := strings.ToLower(topicToAddress(lg.Topics[1]))
				token1 := strings.ToLower(topicToAddress(lg.Topics[2]))
				stable := hexToBig(lg.Topics[3]).Sign() != 0
				words := dataWords(lg.Data)
				if len(words) < 1 {
					continue
				}
				pool := "0x" + strings.ToLower(words[0][24:])
				if seen[pool] {
					continue
				}
				seen[pool] = true
				pools = append(pools, Pool{
					Address:      pool,
					Token0:       token0,
					Token1:       token1,
					Stable:       fmt.Sprintf("%t", stable),
					AoraIsToken0: token0 == cfg.AoraToken,
				})
			}
		}
	}
	log.Printf("discovered %d AORA pool(s)", len(pools))
	return pools, nil
}

// resolveManualPools fills token0/token1 (and AORA position) via eth_call.
func resolveManualPools(c *Client, cfg *Config) ([]Pool, error) {
	block := cfg.EndBlock
	if block == 0 {
		h, err := c.BlockNumber()
		if err != nil {
			return nil, err
		}
		block = h
	}
	var pools []Pool
	for _, addr := range cfg.Pools {
		t0ret, err := c.EthCall(addr, selToken0, block)
		if err != nil {
			return nil, fmt.Errorf("token0 %s: %w", addr, err)
		}
		t1ret, err := c.EthCall(addr, selToken1, block)
		if err != nil {
			return nil, fmt.Errorf("token1 %s: %w", addr, err)
		}
		t0 := returnAddress(t0ret)
		t1 := returnAddress(t1ret)
		pools = append(pools, Pool{
			Address:      addr,
			Token0:       t0,
			Token1:       t1,
			AoraIsToken0: t0 == cfg.AoraToken,
		})
	}
	return pools, nil
}

func writePools(cfg *Config, pools []Pool) error {
	rows := make([][]string, 0, len(pools))
	for _, p := range pools {
		rows = append(rows, []string{p.Address, p.Token0, p.Token1, p.Stable})
	}
	return writeCSV(poolsPath(cfg), []string{"pool", "token0", "token1", "stable"}, rows)
}

func loadPools(cfg *Config) ([]Pool, error) {
	_, rows, err := readCSV(poolsPath(cfg))
	if err != nil {
		return nil, err
	}
	var pools []Pool
	for _, r := range rows {
		if len(r) < 3 {
			continue
		}
		p := Pool{
			Address: strings.ToLower(r[0]),
			Token0:  strings.ToLower(r[1]),
			Token1:  strings.ToLower(r[2]),
		}
		if len(r) > 3 {
			p.Stable = r[3]
		}
		// AoraIsToken0 is (re)derived against cfg in ensurePools.
		pools = append(pools, p)
	}
	return pools, nil
}

// ensurePools returns cached pools or discovers + caches them. The AORA token
// position is recomputed against cfg so a cached file stays correct.
func ensurePools(c *Client, cfg *Config, force bool) ([]Pool, error) {
	var pools []Pool
	var err error
	if !force && fileExists(poolsPath(cfg)) {
		log.Printf("using cached %s", poolsPath(cfg))
		pools, err = loadPools(cfg)
	} else {
		pools, err = DiscoverPools(c, cfg)
		if err != nil {
			return nil, err
		}
		if err := writePools(cfg, pools); err != nil {
			return nil, err
		}
		log.Printf("wrote %s", poolsPath(cfg))
	}
	if err != nil {
		return nil, err
	}
	for i := range pools {
		pools[i].AoraIsToken0 = pools[i].Token0 == cfg.AoraToken
	}
	return pools, nil
}

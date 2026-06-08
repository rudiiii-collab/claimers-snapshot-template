package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"
)

// Config holds all tunable parameters. Values are resolved in this order:
//   built-in default  <  .env file  <  process environment  <  CLI flag
type Config struct {
	RPCURL        string
	AoraToken     string
	VotingReward  string
	Factory       string
	Voter         string // Aerodrome Voter (to resolve CL gauges)
	Pools         []string
	StartBlock    uint64
	EndBlock      uint64
	StepBlocks    uint64
	ChunkBlocks   uint64
	MinClaimed    float64
	OutDir        string
	AoraDecimals  int
	RatePerSecond float64 // max RPC requests/sec
	MaxRetries    int
	MulticallBatch int    // sub-calls per Multicall3 aggregate3
	UseMulticall   bool   // false => fall back to one eth_call per read
	LPStakedOnly   bool   // CL LP: count only gauge-staked positions (matches Dune)
	Cumulative     bool   // claimed accumulates per block (AORA-style) vs fixed total

	// Per-command flags.
	Block     uint64
	FromBlock uint64
	ToBlock   uint64
	Reference string
	Force     bool

	// Dune upload.
	DuneKey     string
	DuneTable   string
	DunePrivate bool
	CSVPath     string
}

// Defaults. The factory is the canonical Aerodrome PoolFactory on Base.
// The token/bribe defaults track $TEA (bridged to Base via Hyperlane); the
// CL/Slipstream pool is USDC/TEA where TEA is token1 (USDC is token0).
const (
	defAoraToken    = "0xa1a0b2e02b0e6830ad5a4a7211691200945d8919" // $TEA token
	defVotingReward = "0xe3460df40a682175972781a1b1330eaba3542118" // TEA bribe / VotingReward
	defFactory      = "0x420dd381b31aef6683db6b902084cb0ffece40da"
	defVoter        = "0x16613524e02ad97edfef371bc883f2f5d6c480a5"
	defPool         = "0xabe1f289107c20081f591bb3972b8289add64f6c" // USDC/TEA CL pool (TEA = token1)
)

func loadDotEnv(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if i := strings.Index(line, "="); i >= 0 {
			k := strings.TrimSpace(line[:i])
			v := strings.TrimSpace(line[i+1:])
			v = strings.Trim(v, `"'`)
			out[k] = v
		}
	}
	return out
}

// LoadConfig parses flags (passed via args) layered over .env + environment.
// args is the slice AFTER the subcommand, e.g. os.Args[2:].
func LoadConfig(args []string) (*Config, error) {
	env := loadDotEnv(".env")
	get := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		if v, ok := env[key]; ok && v != "" {
			return v
		}
		return def
	}

	c := &Config{}
	fs := flag.NewFlagSet("aora", flag.ContinueOnError)

	// Provider-neutral: prefer BASE_RPC, fall back to legacy ALCHEMY_BASE_RPC /
	// CHAINSTACK_BASE_RPC so any provider's URL works unchanged.
	rpcDefault := get("BASE_RPC", "")
	if rpcDefault == "" {
		rpcDefault = get("CHAINSTACK_BASE_RPC", "")
	}
	if rpcDefault == "" {
		rpcDefault = get("ALCHEMY_BASE_RPC", "")
	}
	fs.StringVar(&c.RPCURL, "rpc", rpcDefault, "Base RPC URL (Chainstack/Alchemy/any provider)")
	// Token address: prefer TEA_TOKEN, fall back to legacy AORA_TOKEN.
	tokenDefault := get("TEA_TOKEN", "")
	if tokenDefault == "" {
		tokenDefault = get("AORA_TOKEN", defAoraToken)
	}
	fs.StringVar(&c.AoraToken, "token", strings.ToLower(tokenDefault), "tracked token address (TEA)")
	fs.StringVar(&c.VotingReward, "voting-reward", strings.ToLower(get("VOTING_REWARD", defVotingReward)), "VotingReward (bribe) contract")
	fs.StringVar(&c.Factory, "factory", strings.ToLower(get("AERODROME_FACTORY", defFactory)), "Aerodrome PoolFactory")
	fs.StringVar(&c.Voter, "voter", strings.ToLower(get("AERODROME_VOTER", defVoter)), "Aerodrome Voter (resolves CL gauges)")
	poolsCSV := fs.String("pools", get("POOLS", defPool), "comma-separated pool addresses (manual override)")
	fs.Uint64Var(&c.StartBlock, "start-block", parseUint(get("START_BLOCK", "0")), "start block")
	fs.Uint64Var(&c.EndBlock, "end-block", parseUint(get("END_BLOCK", "0")), "end block")
	fs.Uint64Var(&c.StepBlocks, "step", parseUint(get("STEP_BLOCKS", "3600")), "blocks between snapshots")
	fs.Uint64Var(&c.ChunkBlocks, "chunk", parseUint(get("CHUNK_BLOCKS", "2000")), "getLogs chunk size")
	fs.Float64Var(&c.MinClaimed, "min-claimed", parseFloat(get("MIN_CLAIMED", "1000")), "minimum claimed AORA to include a wallet")
	fs.StringVar(&c.OutDir, "out", get("OUT_DIR", "./data"), "output directory")
	decDefault := get("TEA_DECIMALS", "")
	if decDefault == "" {
		decDefault = get("AORA_DECIMALS", "18")
	}
	fs.IntVar(&c.AoraDecimals, "decimals", int(parseUint(decDefault)), "token decimals")
	fs.Float64Var(&c.RatePerSecond, "rate", parseFloat(get("RATE_PER_SECOND", "8")), "max RPC requests per second")
	fs.IntVar(&c.MaxRetries, "max-retries", int(parseUint(get("MAX_RETRIES", "6"))), "max RPC retries")
	fs.IntVar(&c.MulticallBatch, "multicall-batch", int(parseUint(get("MULTICALL_BATCH", "500"))), "sub-calls per Multicall3 batch")
	useMC := strings.ToLower(get("USE_MULTICALL", "true"))
	c.UseMulticall = useMC != "false" && useMC != "0" && useMC != "no"
	fs.BoolVar(&c.UseMulticall, "multicall", c.UseMulticall, "use Multicall3 batching (default true)")
	stakedOnly := strings.ToLower(get("LP_STAKED_ONLY", "true"))
	c.LPStakedOnly = stakedOnly != "false" && stakedOnly != "0" && stakedOnly != "no"
	fs.BoolVar(&c.LPStakedOnly, "lp-staked-only", c.LPStakedOnly, "count only gauge-staked CL positions for TEA_LP (matches Dune; default true)")

	cumul := strings.ToLower(get("CUMULATIVE_CLAIMED", "true"))
	c.Cumulative = cumul != "false" && cumul != "0" && cumul != "no"
	fs.BoolVar(&c.Cumulative, "cumulative", c.Cumulative, "accumulate claimed per block from ClaimRewards events (AORA-style ramp; default true)")

	fs.Uint64Var(&c.Block, "block", 0, "snapshot block (snapshot command)")
	fs.Uint64Var(&c.FromBlock, "from", 0, "from block (debug-logs)")
	fs.Uint64Var(&c.ToBlock, "to", 0, "to block (debug-logs)")
	fs.StringVar(&c.Reference, "reference", "", "reference CSV path (validate command)")
	fs.BoolVar(&c.Force, "force", false, "ignore caches and recompute")

	fs.StringVar(&c.DuneKey, "dune-key", get("DUNE_API_KEY", ""), "Dune API key (upload-dune)")
	fs.StringVar(&c.DuneTable, "table", "tea_claimers", "Dune table name (upload-dune)")
	fs.BoolVar(&c.DunePrivate, "private", false, "upload the Dune table as private")
	fs.StringVar(&c.CSVPath, "csv", "", "CSV path to upload (default data/dune_aora_claimers.csv)")

	// Allow a single positional --block on snapshot via flag too.
	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if *poolsCSV != "" {
		for _, p := range strings.Split(*poolsCSV, ",") {
			p = strings.ToLower(strings.TrimSpace(p))
			if p != "" {
				c.Pools = append(c.Pools, p)
			}
		}
	}
	return c, nil
}

func parseUint(s string) uint64 {
	var v uint64
	fmt.Sscan(s, &v)
	return v
}

func parseFloat(s string) float64 {
	var v float64
	fmt.Sscan(s, &v)
	return v
}

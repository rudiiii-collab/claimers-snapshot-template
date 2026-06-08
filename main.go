// Command aora reproduces the Dune dataset
// `dune.x_drome_analytics.dataset_aora_claimers` for Aerodrome AORA ignition
// voters on Base, using only a Base JSON-RPC endpoint (e.g. Alchemy free tier).
//
// Per the Dune logic, for each snapshot block and each wallet that claimed
// more than MIN_CLAIMED AORA:
//
//	AORA_Hold = AORA.balanceOf(wallet) / 1e18                       (direct holdings)
//	AORA_LP   = Σ_pools (lpBalance/totalSupply) * aoraReserve / 1e18 (LP exposure)
//	outflow   = claimed - AORA_Hold - AORA_LP                        (by subtraction)
//
// This tool measures *remaining* AORA exposure; everything else is outflow.
// It deliberately does NOT trace outbound transfers.
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func usage() {
	fmt.Print(`aora - reproduce the Dune AORA claimers snapshot dataset

Usage:
  go run . <command> [flags]

Commands:
  discover-pools   Find Aerodrome pools containing AORA (or use POOLS) -> data/pools.csv
  claims           Scan ClaimRewards, aggregate per wallet (>MIN_CLAIMED) -> data/claimers.csv
  import-claimers  Build data/claimers.csv from a reference snapshot CSV, no RPC
                     (--reference <path>)
  snapshot         Compute one block snapshot -> data/snapshots/wallets_block_<block>.csv
                     (requires --block)
  snapshots        Compute a range of snapshots and the time series
                     (requires --start-block/--end-block, optional --step)
  aggregate        Build data/timeseries.csv from existing snapshot CSVs
  validate         Compare a generated snapshot against a reference CSV
                     (--block <n> --reference <path>)
  debug-logs       Print raw topics/data for VotingReward logs (--from --to)

Common flags (also settable via .env / environment):
  --rpc, --token, --voting-reward, --factory, --pools, --start-block, --end-block,
  --step, --chunk, --min-claimed, --out, --decimals, --rate, --max-retries, --force

Examples:
  go run . discover-pools
  go run . claims --start-block 45000000 --end-block 46200000
  go run . snapshot --block 46193958
  go run . snapshots --start-block 45848358 --end-block 46193958 --step 3600
  go run . aggregate
  go run . validate --block 46193958 --reference ./_ref/AORA/wallets_block_46193958.csv
`)
}

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	cmd := os.Args[1]
	if cmd == "-h" || cmd == "--help" || cmd == "help" {
		usage()
		return
	}

	cfg, err := LoadConfig(os.Args[2:])
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := ensureDir(cfg.OutDir); err != nil {
		log.Fatalf("out dir: %v", err)
	}

	// validate is offline; everything else needs an RPC client.
	offline := map[string]bool{"validate": true, "aggregate": true, "import-claimers": true, "export-dune": true, "upload-dune": true}
	needsRPC := !offline[cmd]
	var client *Client
	if needsRPC {
		if cfg.RPCURL == "" {
			log.Fatal("BASE_RPC (or --rpc) is required for this command — set your Chainstack/Alchemy URL in .env")
		}
		client = NewClient(cfg.RPCURL, cfg.RatePerSecond, cfg.MaxRetries)
	}

	switch cmd {
	case "discover-pools":
		pools, err := ensurePools(client, cfg, cfg.Force)
		must(err)
		for _, p := range pools {
			fmt.Printf("%s token0=%s token1=%s stable=%s aoraIsToken0=%t\n",
				p.Address, p.Token0, p.Token1, p.Stable, p.AoraIsToken0)
		}

	case "claims":
		claimers, err := ensureClaimers(client, cfg, cfg.Force)
		must(err)
		fmt.Printf("%d claimers > %g AORA written to %s\n", len(claimers), cfg.MinClaimed, claimersPath(cfg))

	case "import-claimers":
		if cfg.Reference == "" {
			log.Fatal("--reference <path to a reference snapshot CSV> is required")
		}
		claimers, err := ImportClaimers(cfg, cfg.Reference)
		must(err)
		must(writeClaimers(cfg, claimers))
		fmt.Printf("%d claimers imported to %s (no RPC used)\n", len(claimers), claimersPath(cfg))

	case "snapshot":
		if cfg.Block == 0 {
			log.Fatal("--block is required")
		}
		claimers, err := ensureClaimers(client, cfg, false)
		must(err)
		pools, err := ensurePools(client, cfg, false)
		must(err)
		events := ensureClaimEvents(client, cfg, cfg.StartBlock, cfg.Block)
		_, err = RunSnapshot(client, cfg, claimers, pools, cfg.Block, cfg.Force, events)
		must(err)

	case "snapshots":
		if cfg.StartBlock == 0 || cfg.EndBlock == 0 {
			log.Fatal("--start-block and --end-block are required")
		}
		claimers, err := ensureClaimers(client, cfg, false)
		must(err)
		pools, err := ensurePools(client, cfg, false)
		must(err)
		events := ensureClaimEvents(client, cfg, cfg.StartBlock, cfg.EndBlock)
		series, err := RunSnapshots(client, cfg, claimers, pools, cfg.StartBlock, cfg.EndBlock, cfg.StepBlocks, cfg.Force, events)
		must(err)
		must(writeTimeseries(cfg, series))
		fmt.Printf("wrote %d snapshots + %s\n", len(series), filepath.Join(cfg.OutDir, "timeseries.csv"))

	case "aggregate":
		must(runAggregate(cfg))

	case "export-dune":
		must(runExportDune(cfg))

	case "upload-dune":
		must(UploadToDune(cfg))

	case "validate":
		if cfg.Reference == "" {
			log.Fatal("--reference <path> is required")
		}
		if cfg.Block == 0 {
			log.Fatal("--block <n> is required (identifies the generated snapshot)")
		}
		must(Validate(snapshotPath(cfg, cfg.Block), cfg.Reference))

	case "debug-lp":
		if cfg.Block == 0 {
			log.Fatal("--block is required")
		}
		must(DebugLP(client, cfg, cfg.Block, cfg.Reference))

	case "debug-logs":
		if cfg.FromBlock == 0 || cfg.ToBlock == 0 {
			log.Fatal("--from and --to are required")
		}
		must(DebugLogs(client, cfg, cfg.FromBlock, cfg.ToBlock))

	default:
		fmt.Printf("unknown command %q\n\n", cmd)
		usage()
		os.Exit(1)
	}
}

// runAggregate rebuilds timeseries.csv from snapshot files already on disk
// (offline). Useful to resume after interrupted snapshots runs.
func runAggregate(cfg *Config) error {
	dir := filepath.Join(cfg.OutDir, "snapshots")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read snapshots dir: %w", err)
	}
	var blocks []uint64
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "wallets_block_") || !strings.HasSuffix(name, ".csv") {
			continue
		}
		numStr := strings.TrimSuffix(strings.TrimPrefix(name, "wallets_block_"), ".csv")
		if b, err := strconv.ParseUint(numStr, 10, 64); err == nil {
			blocks = append(blocks, b)
		}
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i] < blocks[j] })

	var series []SnapshotTotals
	for _, b := range blocks {
		rows, err := loadSnapshot(cfg, b)
		if err != nil {
			return err
		}
		// Timestamp left 0 in offline aggregate (no RPC); fill via snapshots run.
		series = append(series, totalsFromRows(cfg, b, 0, rows))
	}
	if err := writeTimeseries(cfg, series); err != nil {
		return err
	}
	fmt.Printf("aggregated %d snapshots -> %s\n", len(series), filepath.Join(cfg.OutDir, "timeseries.csv"))
	return nil
}

// runExportDune merges every per-block snapshot into a single CSV suitable for
// uploading to Dune as one table (mirrors dune.x_drome_analytics.dataset_aora_claimers).
// Columns: block,timestamp,wallet,partner,claimed,AORA_LP,AORA_Hold,outflow
func runExportDune(cfg *Config) error {
	// block -> timestamp from timeseries.csv (if present).
	ts := map[string]string{}
	if _, rows, err := readCSV(filepath.Join(cfg.OutDir, "timeseries.csv")); err == nil {
		for _, r := range rows {
			if len(r) >= 2 {
				ts[r[0]] = r[1]
			}
		}
	}

	dir := filepath.Join(cfg.OutDir, "snapshots")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read snapshots dir: %w", err)
	}
	var blocks []uint64
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "wallets_block_") || !strings.HasSuffix(name, ".csv") {
			continue
		}
		n := strings.TrimSuffix(strings.TrimPrefix(name, "wallets_block_"), ".csv")
		if b, err := strconv.ParseUint(n, 10, 64); err == nil {
			blocks = append(blocks, b)
		}
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i] < blocks[j] })

	parse := func(s string) float64 {
		if s == "" || s == "<nil>" {
			return 0
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	// plain renders a number in fixed-decimal notation (never scientific). Dune's
	// CSV uploader infers a column as VARCHAR when any value uses "e+NN" notation,
	// which then breaks numeric SUM/sort in charts. Plain decimals keep the
	// columns typed as DOUBLE.
	plain := func(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

	out := [][]string{}
	for _, b := range blocks {
		bs := strconv.FormatUint(b, 10)
		_, recs, err := readCSV(snapshotPath(cfg, b))
		if err != nil {
			return err
		}
		for _, r := range recs {
			if len(r) < 5 {
				continue
			}
			claimed := parse(r[2])
			lp := parse(r[3])
			hold := parse(r[4])
			outflow := claimed - hold - lp
			partner := r[1]
			if partner == "<nil>" {
				partner = "" // clean empty value for Dune instead of literal "<nil>"
			}
			out = append(out, []string{bs, ts[bs], r[0], partner, plain(claimed), plain(lp), plain(hold), plain(outflow)})
		}
	}
	path := filepath.Join(cfg.OutDir, "dune_tea_claimers.csv")
	if err := writeCSV(path, []string{"block", "timestamp", "wallet", "partner", "claimed", "TEA_LP", "TEA_Hold", "outflow"}, out); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d blocks, %d rows)\n", path, len(blocks), len(out))
	return nil
}

// ensureClaimEvents scans (or loads cached) ClaimRewards events so claimed can be
// accumulated per block. Returns nil when --cumulative is disabled, which makes
// the snapshot fall back to the fixed lifetime total.
func ensureClaimEvents(client *Client, cfg *Config, start, end uint64) []ClaimEvent {
	if !cfg.Cumulative {
		log.Printf("cumulative claimed disabled (--cumulative=false): using fixed lifetime total")
		return nil
	}
	if start == 0 {
		start = cfg.StartBlock
	}
	events, err := ScanClaimEvents(client, cfg, start, end)
	must(err)
	return events
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

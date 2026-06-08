package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SnapshotRow is one wallet's state at a snapshot block.
type SnapshotRow struct {
	Wallet  string
	Claimed *big.Int // raw, fixed total across all snapshots
	Hold    *big.Int // raw AORA balanceOf at block
	LP      *big.Rat // raw AORA exposure across pools at block
}

// SnapshotTotals are the aggregate values for the time series.
type SnapshotTotals struct {
	Block     uint64
	Timestamp uint64
	Claimed   *big.Rat
	Hold      *big.Rat
	LP        *big.Rat
	Outflow   *big.Rat
}

func snapshotPath(cfg *Config, block uint64) string {
	return filepath.Join(cfg.OutDir, "snapshots", fmt.Sprintf("wallets_block_%d.csv", block))
}

func checkpointPath(cfg *Config, block uint64) string {
	return filepath.Join(cfg.OutDir, "cache", fmt.Sprintf("block_%d.json", block))
}

// poolState caches the per-pool, per-block constants (fetched once per block).
type poolState struct {
	pool        Pool
	totalSupply *big.Int
	aoraReserve *big.Int
}

// resultUint reads a multicall result word as a uint (0 on failure/empty).
func resultUint(cr CallResult) *big.Int {
	if !cr.Success || cr.Ret == "" || cr.Ret == "0x" {
		return new(big.Int)
	}
	return returnUint(cr.Ret)
}

// fetchPoolStates loads totalSupply + the AORA-side reserve for each pool at
// `block`, in a single Multicall3 request (or per-call if multicall is off).
func fetchPoolStates(c *Client, cfg *Config, pools []Pool, block uint64) ([]poolState, error) {
	if len(pools) == 0 {
		return nil, nil
	}
	if cfg.UseMulticall {
		calls := make([]Call3, 0, len(pools)*2)
		for _, p := range pools {
			calls = append(calls,
				Call3{Target: p.Address, Data: selTotalSupply},
				Call3{Target: p.Address, Data: selGetReserves})
		}
		res, err := c.MultiCall(calls, block, cfg.MulticallBatch)
		if err != nil {
			return nil, err
		}
		var states []poolState
		for i, p := range pools {
			ts := resultUint(res[i*2])
			if ts.Sign() == 0 {
				continue // pool empty / not yet deployed at this block
			}
			rr := res[i*2+1]
			if !rr.Success {
				continue
			}
			reserves, err := parseReserves(rr.Ret)
			if err != nil {
				return nil, err
			}
			aoraReserve := reserves.Reserve1
			if p.AoraIsToken0 {
				aoraReserve = reserves.Reserve0
			}
			states = append(states, poolState{pool: p, totalSupply: ts, aoraReserve: aoraReserve})
		}
		return states, nil
	}

	// Fallback: one eth_call per read.
	var states []poolState
	for _, p := range pools {
		tsRet, err := c.EthCall(p.Address, selTotalSupply, block)
		if err != nil {
			return nil, fmt.Errorf("totalSupply %s @%d: %w", p.Address, block, err)
		}
		ts := returnUint(tsRet)
		if ts.Sign() == 0 {
			continue
		}
		resRet, err := c.EthCall(p.Address, selGetReserves, block)
		if err != nil {
			return nil, fmt.Errorf("getReserves %s @%d: %w", p.Address, block, err)
		}
		res, err := parseReserves(resRet)
		if err != nil {
			return nil, err
		}
		aoraReserve := res.Reserve1
		if p.AoraIsToken0 {
			aoraReserve = res.Reserve0
		}
		states = append(states, poolState{pool: p, totalSupply: ts, aoraReserve: aoraReserve})
	}
	return states, nil
}

// lpFromBalance computes (lpBalance * aoraReserve) / totalSupply as a big.Rat.
func lpFromBalance(lpBal, aoraReserve, totalSupply *big.Int) *big.Rat {
	if lpBal.Sign() == 0 {
		return new(big.Rat)
	}
	num := new(big.Int).Mul(lpBal, aoraReserve)
	return new(big.Rat).SetFrac(num, totalSupply)
}

// Snapshot computes hold + LP exposure for every claimer at `block`.
//
// Dune-equivalent per-wallet formula:
//
//	AORA_Hold = AORA.balanceOf(wallet) / 1e18
//	AORA_LP   = Σ_pools (lpBalance / totalSupply) * aoraReserve / 1e18
//	outflow   = claimed - AORA_Hold - AORA_LP
//
// With multicall enabled the AORA balance and every pool balance for all wallets
// are fetched in a few batched requests instead of one call per wallet.
func Snapshot(c *Client, cfg *Config, claimers []Claimer, pools []Pool, block uint64) ([]SnapshotRow, error) {
	// v2 pools (with getReserves); CL pools naturally return totalSupply revert
	// and are skipped here, then handled by the CL path below.
	states, err := fetchPoolStates(c, cfg, pools, block)
	if err != nil {
		return nil, err
	}

	// Concentrated-liquidity (Slipstream/v3) pools: positions + V3 math.
	clPools := loadCLPools(c, cfg, pools, block)
	clLP, err := SnapshotCLLP(c, cfg, claimers, clPools, block)
	if err != nil {
		return nil, err
	}

	log.Printf("snapshot block %d: %d claimers, %d v2 pool(s), %d CL pool(s), %d wallets with CL LP, multicall=%t",
		block, len(claimers), len(states), len(clPools), len(clLP), cfg.UseMulticall)

	if cfg.UseMulticall {
		return snapshotMulticall(c, cfg, claimers, states, clLP, block)
	}
	return snapshotPerCall(c, cfg, claimers, states, clLP, block)
}

// loadCLPools probes each configured pool and returns those that are
// concentrated-liquidity (i.e. expose slot0()).
func loadCLPools(c *Client, cfg *Config, pools []Pool, block uint64) []*CLPool {
	var cl []*CLPool
	for _, p := range pools {
		clp, err := loadCLPool(c, cfg, p.Address, block)
		if err != nil || clp.SqrtPriceX96.Sign() == 0 {
			continue // not a CL pool (slot0 reverted) or empty
		}
		cl = append(cl, clp)
	}
	return cl
}

// snapshotMulticall batches one AORA balanceOf + one balanceOf per pool for every
// wallet into Multicall3 batches. For W wallets and P pools this is
// ceil(W*(1+P)/batch) requests instead of W*(1+P).
func snapshotMulticall(c *Client, cfg *Config, claimers []Claimer, states []poolState, clLP map[string]*big.Int, block uint64) ([]SnapshotRow, error) {
	perWallet := 1 + len(states)
	calls := make([]Call3, 0, len(claimers)*perWallet)
	for _, cl := range claimers {
		calls = append(calls, Call3{Target: cfg.AoraToken, Data: callDataBalanceOf(cl.Wallet)})
		for _, st := range states {
			calls = append(calls, Call3{Target: st.pool.Address, Data: callDataBalanceOf(cl.Wallet)})
		}
	}
	res, err := c.MultiCall(calls, block, cfg.MulticallBatch)
	if err != nil {
		return nil, err
	}
	log.Printf("  multicall: %d sub-calls in %d batch(es)", len(calls), (len(calls)+cfg.MulticallBatch-1)/max(cfg.MulticallBatch, 1))

	rows := make([]SnapshotRow, 0, len(claimers))
	for i, cl := range claimers {
		base := i * perWallet
		hold := resultUint(res[base])
		lp := new(big.Rat)
		for p, st := range states {
			lpBal := resultUint(res[base+1+p])
			lp.Add(lp, lpFromBalance(lpBal, st.aoraReserve, st.totalSupply))
		}
		if amt, ok := clLP[cl.Wallet]; ok {
			lp.Add(lp, new(big.Rat).SetInt(amt))
		}
		rows = append(rows, SnapshotRow{Wallet: cl.Wallet, Claimed: cl.Raw, Hold: hold, LP: lp})
	}
	return rows, nil
}

// snapshotPerCall is the non-batched fallback (one eth_call per read).
func snapshotPerCall(c *Client, cfg *Config, claimers []Claimer, states []poolState, clLP map[string]*big.Int, block uint64) ([]SnapshotRow, error) {
	rows := make([]SnapshotRow, 0, len(claimers))
	for i, cl := range claimers {
		balRet, err := c.EthCall(cfg.AoraToken, callDataBalanceOf(cl.Wallet), block)
		if err != nil {
			return nil, fmt.Errorf("balanceOf %s @%d: %w", cl.Wallet, block, err)
		}
		hold := returnUint(balRet)
		lp := new(big.Rat)
		for _, st := range states {
			lpRet, err := c.EthCall(st.pool.Address, callDataBalanceOf(cl.Wallet), block)
			if err != nil {
				return nil, fmt.Errorf("pool balanceOf %s @%d: %w", st.pool.Address, block, err)
			}
			lp.Add(lp, lpFromBalance(returnUint(lpRet), st.aoraReserve, st.totalSupply))
		}
		if amt, ok := clLP[cl.Wallet]; ok {
			lp.Add(lp, new(big.Rat).SetInt(amt))
		}
		rows = append(rows, SnapshotRow{Wallet: cl.Wallet, Claimed: cl.Raw, Hold: hold, LP: lp})
		if (i+1)%100 == 0 {
			log.Printf("  ...%d/%d wallets", i+1, len(claimers))
		}
	}
	return rows, nil
}

func writeSnapshot(cfg *Config, block uint64, rows []SnapshotRow) error {
	out := make([][]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, []string{
			r.Wallet,
			"<nil>", // partner: hand-labeled in the reference dataset, not on-chain
			formatAmount(r.Claimed, cfg.AoraDecimals),
			formatAmountRat(r.LP, cfg.AoraDecimals),
			formatAmount(r.Hold, cfg.AoraDecimals),
		})
	}
	return writeCSV(snapshotPath(cfg, block),
		[]string{"wallet", "partner", "claimed", "TEA_LP", "TEA_Hold"}, out)
}

// ---- lossless JSON checkpoint (resume) ----

type jsonRow struct {
	Wallet     string `json:"wallet"`
	ClaimedRaw string `json:"claimed_raw"`
	HoldRaw    string `json:"hold_raw"`
	LPNum      string `json:"lp_num"`
	LPDen      string `json:"lp_den"`
}

type checkpoint struct {
	Block     uint64    `json:"block"`
	Timestamp uint64    `json:"timestamp"`
	Decimals  int       `json:"decimals"`
	Rows      []jsonRow `json:"rows"`
}

func saveCheckpoint(cfg *Config, block, ts uint64, rows []SnapshotRow) error {
	cp := checkpoint{Block: block, Timestamp: ts, Decimals: cfg.AoraDecimals}
	for _, r := range rows {
		cp.Rows = append(cp.Rows, jsonRow{
			Wallet:     r.Wallet,
			ClaimedRaw: r.Claimed.String(),
			HoldRaw:    r.Hold.String(),
			LPNum:      r.LP.Num().String(),
			LPDen:      r.LP.Denom().String(),
		})
	}
	if err := ensureDir(filepath.Dir(checkpointPath(cfg, block))); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cp, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(checkpointPath(cfg, block), b, 0o644)
}

func loadCheckpoint(cfg *Config, block uint64) (*checkpoint, []SnapshotRow, error) {
	b, err := os.ReadFile(checkpointPath(cfg, block))
	if err != nil {
		return nil, nil, err
	}
	var cp checkpoint
	if err := json.Unmarshal(b, &cp); err != nil {
		return nil, nil, err
	}
	rows := make([]SnapshotRow, 0, len(cp.Rows))
	for _, jr := range cp.Rows {
		claimed, _ := new(big.Int).SetString(jr.ClaimedRaw, 10)
		hold, _ := new(big.Int).SetString(jr.HoldRaw, 10)
		num, _ := new(big.Int).SetString(jr.LPNum, 10)
		den, _ := new(big.Int).SetString(jr.LPDen, 10)
		if claimed == nil {
			claimed = new(big.Int)
		}
		if hold == nil {
			hold = new(big.Int)
		}
		lp := new(big.Rat)
		if num != nil && den != nil && den.Sign() != 0 {
			lp.SetFrac(num, den)
		}
		rows = append(rows, SnapshotRow{Wallet: jr.Wallet, Claimed: claimed, Hold: hold, LP: lp})
	}
	return &cp, rows, nil
}

// totalsFromRows aggregates a snapshot into time-series totals.
func totalsFromRows(cfg *Config, block, ts uint64, rows []SnapshotRow) SnapshotTotals {
	denom := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(cfg.AoraDecimals)), nil))
	claimed := new(big.Rat)
	hold := new(big.Rat)
	lp := new(big.Rat)
	for _, r := range rows {
		claimed.Add(claimed, new(big.Rat).Quo(new(big.Rat).SetInt(r.Claimed), denom))
		hold.Add(hold, new(big.Rat).Quo(new(big.Rat).SetInt(r.Hold), denom))
		lp.Add(lp, new(big.Rat).Quo(r.LP, denom))
	}
	outflow := new(big.Rat).Sub(claimed, hold)
	outflow.Sub(outflow, lp)
	return SnapshotTotals{Block: block, Timestamp: ts, Claimed: claimed, Hold: hold, LP: lp, Outflow: outflow}
}

// applyCumulativeClaimed overrides each row's Claimed with the amount that wallet
// had actually claimed up to `block` (AORA-style ramp). With events == nil the
// rows keep their fixed lifetime total.
func applyCumulativeClaimed(rows []SnapshotRow, events []ClaimEvent, block uint64) {
	if events == nil {
		return
	}
	cum := cumulativeClaimed(events, block)
	for i := range rows {
		if raw := cum[rows[i].Wallet]; raw != nil {
			rows[i].Claimed = raw
		} else {
			rows[i].Claimed = new(big.Int)
		}
	}
}

// RunSnapshot computes (or resumes from a JSON checkpoint) a single block
// snapshot, writes the CSV, and returns time-series totals. When `events` is
// non-nil, claimed is accumulated per block instead of using the fixed total —
// and cached checkpoints (which hold the expensive balance/LP reads) are reused,
// so only `claimed` is recomputed with no extra RPC.
func RunSnapshot(c *Client, cfg *Config, claimers []Claimer, pools []Pool, block uint64, force bool, events []ClaimEvent) (SnapshotTotals, error) {
	if !force && fileExists(checkpointPath(cfg, block)) {
		log.Printf("resuming from checkpoint %s", checkpointPath(cfg, block))
		cp, rows, err := loadCheckpoint(cfg, block)
		if err != nil {
			return SnapshotTotals{}, err
		}
		if events != nil {
			// Reuse cached hold/LP; recompute claimed cumulatively and persist.
			applyCumulativeClaimed(rows, events, block)
			if err := saveCheckpoint(cfg, block, cp.Timestamp, rows); err != nil {
				return SnapshotTotals{}, err
			}
			if err := writeSnapshot(cfg, block, rows); err != nil {
				return SnapshotTotals{}, err
			}
		} else if !fileExists(snapshotPath(cfg, block)) {
			if err := writeSnapshot(cfg, block, rows); err != nil {
				return SnapshotTotals{}, err
			}
		}
		return totalsFromRows(cfg, block, cp.Timestamp, rows), nil
	}

	// Fresh compute. Override claimed with the cumulative-to-block amount.
	effClaimers := claimers
	if events != nil {
		cum := cumulativeClaimed(events, block)
		effClaimers = make([]Claimer, len(claimers))
		for i, cl := range claimers {
			raw := cum[cl.Wallet]
			if raw == nil {
				raw = new(big.Int)
			}
			effClaimers[i] = Claimer{Wallet: cl.Wallet, Raw: raw}
		}
	}

	rows, err := Snapshot(c, cfg, effClaimers, pools, block)
	if err != nil {
		return SnapshotTotals{}, err
	}
	ts, _ := c.BlockTimestamp(block)
	if err := saveCheckpoint(cfg, block, ts, rows); err != nil {
		return SnapshotTotals{}, err
	}
	if err := writeSnapshot(cfg, block, rows); err != nil {
		return SnapshotTotals{}, err
	}
	log.Printf("wrote %s (+ checkpoint)", snapshotPath(cfg, block))
	return totalsFromRows(cfg, block, ts, rows), nil
}

// loadSnapshot reads a cached snapshot CSV back into rows (for offline aggregate).
func loadSnapshot(cfg *Config, block uint64) ([]SnapshotRow, error) {
	// Prefer the lossless JSON checkpoint when present.
	if fileExists(checkpointPath(cfg, block)) {
		_, rows, err := loadCheckpoint(cfg, block)
		if err == nil {
			return rows, nil
		}
	}
	_, recs, err := readCSV(snapshotPath(cfg, block))
	if err != nil {
		return nil, err
	}
	denom := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(cfg.AoraDecimals)), nil)
	scaleToRaw := func(dec string) *big.Int {
		r := new(big.Rat)
		r.SetString(dec)
		r.Mul(r, new(big.Rat).SetInt(denom))
		return new(big.Int).Quo(r.Num(), r.Denom())
	}
	var rows []SnapshotRow
	for _, rec := range recs {
		if len(rec) < 5 {
			continue
		}
		lpRat := new(big.Rat)
		lpRat.SetString(rec[3])
		lpRat.Mul(lpRat, new(big.Rat).SetInt(denom))
		rows = append(rows, SnapshotRow{
			Wallet:  strings.ToLower(rec[0]),
			Claimed: scaleToRaw(rec[2]),
			LP:      lpRat,
			Hold:    scaleToRaw(rec[4]),
		})
	}
	return rows, nil
}

// RunSnapshots iterates blocks [start,end] by step, writing one CSV per block
// and accumulating the time series. Each block is checkpointed, so an
// interrupted run resumes without recomputing completed blocks.
func RunSnapshots(c *Client, cfg *Config, claimers []Claimer, pools []Pool, start, end, step uint64, force bool, events []ClaimEvent) ([]SnapshotTotals, error) {
	if step == 0 {
		step = 3600
	}
	var series []SnapshotTotals
	for b := start; b <= end; b += step {
		t, err := RunSnapshot(c, cfg, claimers, pools, b, force, events)
		if err != nil {
			return series, err
		}
		series = append(series, t)
	}
	return series, nil
}

func writeTimeseries(cfg *Config, series []SnapshotTotals) error {
	rows := make([][]string, 0, len(series))
	for _, s := range series {
		f := func(r *big.Rat) string { v, _ := r.Float64(); return formatFloatLikePython(v) }
		rows = append(rows, []string{
			strconv.FormatUint(s.Block, 10),
			strconv.FormatUint(s.Timestamp, 10),
			f(s.Claimed), f(s.LP), f(s.Hold), f(s.Outflow),
		})
	}
	return writeCSV(filepath.Join(cfg.OutDir, "timeseries.csv"),
		[]string{"block", "timestamp", "claimed", "lp", "hold", "outflow"}, rows)
}

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Claimer is a wallet plus its total claimed AORA (raw 18-dec integer).
type Claimer struct {
	Wallet string
	Raw    *big.Int
}

// claimersPath is the cached claimer list.
func claimersPath(c *Config) string { return filepath.Join(c.OutDir, "claimers.csv") }

// claimProgress is the resumable checkpoint for a claims scan: the accumulated
// per-wallet totals plus the next block to scan. Saved periodically so a flaky
// RPC / timeout never loses work — re-running picks up where it stopped.
type claimProgress struct {
	Start  uint64            `json:"start"`
	End    uint64            `json:"end"`
	Next   uint64            `json:"next"`
	Totals map[string]string `json:"totals"` // wallet -> raw big.Int (base units)
}

func claimProgressPath(cfg *Config) string {
	return filepath.Join(cfg.OutDir, "cache", "claims_progress.json")
}

func saveClaimProgress(cfg *Config, start, end, next uint64, totals map[string]*big.Int) {
	p := claimProgress{Start: start, End: end, Next: next, Totals: map[string]string{}}
	for w, v := range totals {
		p.Totals[w] = v.String()
	}
	_ = ensureDir(filepath.Dir(claimProgressPath(cfg)))
	if b, err := json.MarshalIndent(p, "", "  "); err == nil {
		_ = os.WriteFile(claimProgressPath(cfg), b, 0o644)
	}
}

func loadClaimProgress(cfg *Config) *claimProgress {
	b, err := os.ReadFile(claimProgressPath(cfg))
	if err != nil {
		return nil
	}
	var p claimProgress
	if json.Unmarshal(b, &p) != nil {
		return nil
	}
	return &p
}

// ScanClaims replicates the Dune query:
//
//	SELECT "from" AS addy
//	FROM aerodrome_base.votingreward_evt_claimrewards
//	WHERE contract_address = VOTING_REWARD AND reward = AORA
//	GROUP BY 1 HAVING SUM(amount/1e18) > MIN_CLAIMED
//
// It scans ClaimRewards logs in chunks, automatically shrinking the window when
// a provider rejects the range, and checkpoints progress so it is resumable.
func ScanClaims(c *Client, cfg *Config) ([]Claimer, error) {
	end := cfg.EndBlock
	if end == 0 {
		h, err := c.BlockNumber()
		if err != nil {
			return nil, err
		}
		end = h
	}
	start := cfg.StartBlock
	chunk := cfg.ChunkBlocks
	if chunk == 0 {
		chunk = 2000
	}

	totals := map[string]*big.Int{}
	next := start
	if p := loadClaimProgress(cfg); p != nil && p.Start == start && p.End == end && p.Next > start {
		next = p.Next
		for w, v := range p.Totals {
			if bi, ok := new(big.Int).SetString(v, 10); ok {
				totals[w] = bi
			}
		}
		log.Printf("resuming claims scan at block %d (%d wallets accumulated so far)", next, len(totals))
	}

	log.Printf("scanning ClaimRewards on %s from block %d to %d (topic0=%s)",
		cfg.VotingReward, next, end, topicClaimRewards)

	sinceSave := 0
	for from := next; from <= end; {
		to := from + chunk - 1
		if to > end {
			to = end
		}
		// reward is an indexed topic — filter server-side by topic2 = TEA.
		logs, err := c.GetLogs(cfg.VotingReward, from, to, []any{topicClaimRewards, nil, addressTopic(cfg.AoraToken)})
		if err != nil {
			if isRangeError(err) {
				nc, ok := parseSuggestedRange(err.Error())
				if !ok || nc == 0 || nc >= chunk {
					nc = chunk / 2
				}
				if nc < 1 {
					nc = 1
				}
				log.Printf("provider rejected %d-block range; shrinking to %d and retrying", chunk, nc)
				chunk = nc
				continue // retry the same `from` with a smaller window
			}
			// Non-range error (e.g. timeout after retries): save and bail so a
			// re-run resumes instead of starting over.
			saveClaimProgress(cfg, start, end, from, totals)
			return nil, fmt.Errorf("getLogs [%d,%d]: %w (progress saved; re-run to resume)", from, to, err)
		}
		for _, lg := range logs {
			if len(lg.Topics) < 3 {
				continue
			}
			words := dataWords(lg.Data)
			if len(words) < 1 {
				continue
			}
			// topic1=from, topic2=reward (filtered to TEA), data[0]=amount.
			amount := hexToBig("0x" + words[0])
			wallet := strings.ToLower(topicToAddress(lg.Topics[1]))
			if totals[wallet] == nil {
				totals[wallet] = new(big.Int)
			}
			totals[wallet].Add(totals[wallet], amount)
		}
		if len(logs) > 0 {
			log.Printf("  blocks [%d,%d]: %d logs, %d wallets so far", from, to, len(logs), len(totals))
		}
		from = to + 1
		if sinceSave++; sinceSave >= 50 {
			saveClaimProgress(cfg, start, end, from, totals)
			log.Printf("  ...checkpoint saved at block %d (%d wallets)", from, len(totals))
			sinceSave = 0
		}
	}
	saveClaimProgress(cfg, start, end, end+1, totals) // mark complete

	// HAVING SUM(amount/1e18) > MIN_CLAIMED
	denom := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(cfg.AoraDecimals)), nil)
	minRat := new(big.Rat).SetFloat64(cfg.MinClaimed)
	var out []Claimer
	for w, raw := range totals {
		val := new(big.Rat).SetFrac(raw, denom)
		if val.Cmp(minRat) > 0 {
			out = append(out, Claimer{Wallet: w, Raw: raw})
		}
	}
	// Sort descending by claimed (matches the reference file ordering).
	sort.Slice(out, func(i, j int) bool { return out[i].Raw.Cmp(out[j].Raw) > 0 })
	log.Printf("found %d wallets with claimed > %g AORA", len(out), cfg.MinClaimed)
	return out, nil
}

// ---- cumulative claimed (AORA-style) -------------------------------------
//
// import-claimers gives each wallet a fixed *lifetime* claimed total, applied to
// every snapshot block. That makes the "claimed" envelope flat and dumps the
// whole amount into the first block's outflow. The reference AORA dataset instead
// uses claimed accumulated *up to each block*, so the series ramps naturally.
//
// ClaimEvent is one ClaimRewards emission, retaining its block so we can build
// claimed(wallet, block) = Σ amount where event.block ≤ block.
type ClaimEvent struct {
	Wallet string
	Block  uint64
	Amount *big.Int
}

func claimEventsPath(cfg *Config) string {
	return filepath.Join(cfg.OutDir, "cache", "claim_events.json")
}

type claimEventJSON struct {
	Wallet string `json:"wallet"`
	Block  uint64 `json:"block"`
	Amount string `json:"amount"`
}

type claimEventsFile struct {
	Start  uint64           `json:"start"`
	End    uint64           `json:"end"`
	Reward string           `json:"reward"`
	Bribe  string           `json:"bribe"`
	Events []claimEventJSON `json:"events"`
}

func saveClaimEvents(cfg *Config, start, end uint64, evs []ClaimEvent) error {
	f := claimEventsFile{Start: start, End: end, Reward: cfg.AoraToken, Bribe: cfg.VotingReward}
	for _, e := range evs {
		f.Events = append(f.Events, claimEventJSON{Wallet: e.Wallet, Block: e.Block, Amount: e.Amount.String()})
	}
	if err := ensureDir(filepath.Dir(claimEventsPath(cfg))); err != nil {
		return err
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(claimEventsPath(cfg), b, 0o644)
}

func loadClaimEvents(cfg *Config, start, end uint64) ([]ClaimEvent, bool) {
	b, err := os.ReadFile(claimEventsPath(cfg))
	if err != nil {
		return nil, false
	}
	var f claimEventsFile
	if json.Unmarshal(b, &f) != nil {
		return nil, false
	}
	// Only reuse a cache that covers the same scan window + same contracts.
	if f.Start != start || f.End != end || f.Reward != cfg.AoraToken || f.Bribe != cfg.VotingReward {
		return nil, false
	}
	out := make([]ClaimEvent, 0, len(f.Events))
	for _, e := range f.Events {
		amt, ok := new(big.Int).SetString(e.Amount, 10)
		if !ok {
			continue
		}
		out = append(out, ClaimEvent{Wallet: strings.ToLower(e.Wallet), Block: e.Block, Amount: amt})
	}
	return out, true
}

// ScanClaimEvents reads every ClaimRewards(reward=TEA) emission from the bribe
// contract over [start,end], keeping the block of each so claimed can be
// accumulated per snapshot block. Results are cached to data/cache/claim_events.json.
func ScanClaimEvents(c *Client, cfg *Config, start, end uint64) ([]ClaimEvent, error) {
	if cached, ok := loadClaimEvents(cfg, start, end); ok {
		log.Printf("using cached %s (%d ClaimRewards events)", claimEventsPath(cfg), len(cached))
		return cached, nil
	}
	// maxChunk is the optimistic window; the provider caps a response at ~10k
	// logs, so dense regions get shrunk and sparse regions grow back toward it.
	maxChunk := cfg.ChunkBlocks
	if maxChunk < 1 {
		maxChunk = 50000
	}
	chunk := maxChunk
	log.Printf("scanning ClaimRewards events on %s from block %d to %d for cumulative claimed", cfg.VotingReward, start, end)

	var evs []ClaimEvent
	for from := start; from <= end; {
		to := from + chunk - 1
		if to > end {
			to = end
		}
		// reward is an indexed topic, so filter server-side by topic2 = TEA. This
		// keeps the response far under the provider's log cap, letting us use big
		// block ranges instead of being forced down to ~10 blocks.
		logs, err := c.GetLogs(cfg.VotingReward, from, to, []any{topicClaimRewards, nil, addressTopic(cfg.AoraToken)})
		if err != nil {
			if isRangeError(err) {
				nc, ok := parseSuggestedRange(err.Error())
				if !ok || nc == 0 || nc >= chunk {
					nc = chunk / 2
				}
				if nc < 1 {
					nc = 1
				}
				log.Printf("provider rejected %d-block range; shrinking to %d and retrying", chunk, nc)
				chunk = nc
				continue
			}
			return nil, fmt.Errorf("getLogs [%d,%d]: %w", from, to, err)
		}
		for _, lg := range logs {
			if len(lg.Topics) < 3 {
				continue
			}
			words := dataWords(lg.Data)
			if len(words) < 1 {
				continue
			}
			// topic1=from, topic2=reward (already filtered to TEA), data[0]=amount.
			evs = append(evs, ClaimEvent{
				Wallet: strings.ToLower(topicToAddress(lg.Topics[1])),
				Block:  hexToUint64(lg.BlockNumber),
				Amount: hexToBig("0x" + words[0]),
			})
		}
		if len(logs) > 0 {
			log.Printf("  blocks [%d,%d]: %d logs, %d events so far", from, to, len(logs), len(evs))
		}
		from = to + 1
	}
	log.Printf("found %d ClaimRewards events", len(evs))
	if err := saveClaimEvents(cfg, start, end, evs); err != nil {
		log.Printf("warning: could not cache claim events: %v", err)
	}
	return evs, nil
}

// cumulativeClaimed sums each wallet's claimed amount up to and including `block`.
func cumulativeClaimed(evs []ClaimEvent, block uint64) map[string]*big.Int {
	out := map[string]*big.Int{}
	for _, e := range evs {
		if e.Block > block {
			continue
		}
		if out[e.Wallet] == nil {
			out[e.Wallet] = new(big.Int)
		}
		out[e.Wallet].Add(out[e.Wallet], e.Amount)
	}
	return out
}

func writeClaimers(cfg *Config, claimers []Claimer) error {
	rows := make([][]string, 0, len(claimers))
	for _, cl := range claimers {
		rows = append(rows, []string{
			cl.Wallet,
			cl.Raw.String(),
			formatAmount(cl.Raw, cfg.AoraDecimals),
		})
	}
	return writeCSV(claimersPath(cfg), []string{"wallet", "claimed_raw", "claimed_decimal"}, rows)
}

// loadClaimers reads a cached claimers.csv.
func loadClaimers(cfg *Config) ([]Claimer, error) {
	_, rows, err := readCSV(claimersPath(cfg))
	if err != nil {
		return nil, err
	}
	out := make([]Claimer, 0, len(rows))
	for _, r := range rows {
		if len(r) < 2 {
			continue
		}
		raw, ok := new(big.Int).SetString(r[1], 10)
		if !ok {
			continue
		}
		out = append(out, Claimer{Wallet: strings.ToLower(r[0]), Raw: raw})
	}
	return out, nil
}

// ensureClaimers returns cached claimers or scans + caches them.
func ensureClaimers(c *Client, cfg *Config, force bool) ([]Claimer, error) {
	if !force && fileExists(claimersPath(cfg)) {
		log.Printf("using cached %s", claimersPath(cfg))
		return loadClaimers(cfg)
	}
	if force {
		// Start a genuinely fresh scan, discarding any partial progress.
		_ = os.Remove(claimProgressPath(cfg))
	}
	claimers, err := ScanClaims(c, cfg)
	if err != nil {
		return nil, err
	}
	if err := writeClaimers(cfg, claimers); err != nil {
		return nil, err
	}
	log.Printf("wrote %s", claimersPath(cfg))
	return claimers, nil
}

// ImportClaimers builds claimers.csv from a reference CSV. The reference may
// list a wallet on multiple rows (one per claim/epoch); rows are aggregated per
// wallet so each distinct wallet appears once with its summed total. Wallets are
// then filtered by MIN_CLAIMED, reproducing the Dune query's GROUP BY ... HAVING.
//
// Deduping is essential for the cumulative-claimed path: there it assigns each
// wallet ROW the wallet's full per-block cumulative, so duplicate rows would
// multiply that wallet's contribution.
func ImportClaimers(cfg *Config, refPath string) ([]Claimer, error) {
	header, rows, err := readCSV(refPath)
	if err != nil {
		return nil, err
	}
	// Locate columns by name. We support both the reference layouts:
	//   reference snapshot CSV: wallet,partner,claimed,...
	//   claimers CSV:           claimed_decimal,claimed_raw,wallet  (TEA reference)
	// raw (an exact base-unit integer) is preferred; the decimal column is a
	// rounded fallback. Defaults match the snapshot layout when unnamed.
	wi, ci, ri := 0, 2, -1
	for i, h := range header {
		switch strings.ToLower(strings.TrimSpace(h)) {
		case "wallet":
			wi = i
		case "claimed", "claimed_decimal":
			ci = i
		case "claimed_raw":
			ri = i
		}
	}
	denom := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(cfg.AoraDecimals)), nil)
	minRat := new(big.Rat).SetFloat64(cfg.MinClaimed)

	// Aggregate raw totals per distinct wallet (handles multi-row wallets).
	totals := map[string]*big.Int{}
	var order []string // preserve first-seen order before sorting
	for _, r := range rows {
		if len(r) <= wi {
			continue
		}
		wallet := strings.ToLower(strings.TrimSpace(r[wi]))
		if wallet == "" {
			continue
		}

		var rawInt *big.Int
		if ri >= 0 && len(r) > ri {
			// Exact path: parse the raw base-unit integer directly.
			s := strings.TrimSpace(r[ri])
			if v, ok := new(big.Int).SetString(s, 10); ok {
				rawInt = v
			}
		}
		if rawInt == nil {
			// Fallback: round(claimed_decimal * 10^decimals).
			if len(r) <= ci {
				continue
			}
			dec := strings.TrimSpace(r[ci])
			if dec == "" || dec == "<nil>" {
				continue
			}
			val := new(big.Rat)
			if _, ok := val.SetString(dec); !ok {
				continue
			}
			raw := new(big.Rat).Mul(val, new(big.Rat).SetInt(denom))
			rawInt = new(big.Int).Quo(raw.Num(), raw.Denom())
		}

		if totals[wallet] == nil {
			totals[wallet] = new(big.Int)
			order = append(order, wallet)
		}
		totals[wallet].Add(totals[wallet], rawInt)
	}

	var out []Claimer
	for _, wallet := range order {
		raw := totals[wallet]
		// HAVING SUM(amount/10^decimals) > MIN_CLAIMED.
		if new(big.Rat).SetFrac(raw, denom).Cmp(minRat) <= 0 {
			continue
		}
		out = append(out, Claimer{Wallet: wallet, Raw: raw})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Raw.Cmp(out[j].Raw) > 0 })
	log.Printf("imported %d claimers (> %g TEA) from %s", len(out), cfg.MinClaimed, refPath)
	return out, nil
}

// DebugLogs prints raw topics/data for VotingReward logs over a small range,
// to confirm the ClaimRewards signature against on-chain data.
func DebugLogs(c *Client, cfg *Config, from, to uint64) error {
	logs, err := c.GetLogs(cfg.VotingReward, from, to, nil)
	if err != nil {
		return err
	}
	fmt.Printf("computed ClaimRewards topic0 = %s\n", topicClaimRewards)
	fmt.Printf("%d logs from %s in [%d,%d]\n", len(logs), cfg.VotingReward, from, to)
	for i, lg := range logs {
		fmt.Printf("--- log %d block=%d tx=%s\n", i, hexToUint64(lg.BlockNumber), lg.TxHash)
		for j, t := range lg.Topics {
			fmt.Printf("    topic[%d]=%s\n", j, t)
		}
		for k, w := range dataWords(lg.Data) {
			fmt.Printf("    data[%d]=%s\n", k, w)
		}
	}
	return nil
}

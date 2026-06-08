package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// parseFloatCol parses a reference cell, treating "<nil>"/"" as 0.
func parseFloatCol(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "<nil>" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

type walletVals struct {
	claimed float64
	lp      float64
	hold    float64
}

func loadSnapshotFloats(path string) (map[string]walletVals, error) {
	header, rows, err := readCSV(path)
	if err != nil {
		return nil, err
	}
	// Column indices: wallet,partner,claimed,AORA_LP,AORA_Hold
	idx := map[string]int{}
	for i, h := range header {
		idx[strings.ToLower(strings.TrimSpace(h))] = i
	}
	col := func(rec []string, name string, def int) string {
		if i, ok := idx[name]; ok && i < len(rec) {
			return rec[i]
		}
		if def < len(rec) {
			return rec[def]
		}
		return ""
	}
	out := map[string]walletVals{}
	for _, rec := range rows {
		if len(rec) == 0 {
			continue
		}
		w := strings.ToLower(strings.TrimSpace(col(rec, "wallet", 0)))
		if w == "" {
			continue
		}
		out[w] = walletVals{
			claimed: parseFloatCol(col(rec, "claimed", 2)),
			lp:      parseFloatCol(col(rec, "aora_lp", 3)),
			hold:    parseFloatCol(col(rec, "aora_hold", 4)),
		}
	}
	return out, nil
}

// Validate joins a generated snapshot against a reference CSV and reports
// aggregate + top per-wallet differences.
func Validate(generatedPath, referencePath string) error {
	gen, err := loadSnapshotFloats(generatedPath)
	if err != nil {
		return fmt.Errorf("read generated %s: %w", generatedPath, err)
	}
	ref, err := loadSnapshotFloats(referencePath)
	if err != nil {
		return fmt.Errorf("read reference %s: %w", referencePath, err)
	}

	// Union of wallets.
	all := map[string]bool{}
	for w := range gen {
		all[w] = true
	}
	for w := range ref {
		all[w] = true
	}

	var gClaim, rClaim, gLP, rLP, gHold, rHold float64
	type diff struct {
		wallet               string
		dClaim, dLP, dHold   float64
		inGen, inRef         bool
	}
	var diffs []diff
	onlyGen, onlyRef := 0, 0
	for w := range all {
		g, okG := gen[w]
		r, okR := ref[w]
		if okG && !okR {
			onlyGen++
		}
		if okR && !okG {
			onlyRef++
		}
		gClaim += g.claimed
		rClaim += r.claimed
		gLP += g.lp
		rLP += r.lp
		gHold += g.hold
		rHold += r.hold
		diffs = append(diffs, diff{
			wallet: w,
			dClaim: math.Abs(g.claimed - r.claimed),
			dLP:    math.Abs(g.lp - r.lp),
			dHold:  math.Abs(g.hold - r.hold),
			inGen:  okG, inRef: okR,
		})
	}

	fmt.Printf("=== validation: %s vs %s ===\n", generatedPath, referencePath)
	fmt.Printf("wallets: generated=%d reference=%d only-in-generated=%d only-in-reference=%d\n",
		len(gen), len(ref), onlyGen, onlyRef)
	row := func(name string, g, r float64) {
		fmt.Printf("%-10s generated=%.6f reference=%.6f diff=%.6f\n", name, g, r, g-r)
	}
	row("claimed", gClaim, rClaim)
	row("AORA_LP", gLP, rLP)
	row("AORA_Hold", gHold, rHold)

	// Top 20 by combined LP+Hold absolute difference.
	sort.Slice(diffs, func(i, j int) bool {
		return (diffs[i].dLP + diffs[i].dHold) > (diffs[j].dLP + diffs[j].dHold)
	})
	fmt.Printf("\ntop wallet-level differences (|ΔLP|+|ΔHold|):\n")
	fmt.Printf("%-44s %14s %14s %14s  %s\n", "wallet", "dClaimed", "dLP", "dHold", "presence")
	n := 20
	if len(diffs) < n {
		n = len(diffs)
	}
	for i := 0; i < n; i++ {
		d := diffs[i]
		presence := "both"
		if d.inGen && !d.inRef {
			presence = "gen-only"
		} else if d.inRef && !d.inGen {
			presence = "ref-only"
		}
		fmt.Printf("%-44s %14.4f %14.4f %14.4f  %s\n", d.wallet, d.dClaim, d.dLP, d.dHold, presence)
	}
	return nil
}

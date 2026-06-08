package main

import (
	"encoding/csv"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// formatAmount converts a raw token integer (with `decimals`) into a decimal
// string using shortest round-trip float formatting, mirroring how the Dune /
// Python reference dataset prints values (e.g. "0.0", "380000.00000000006",
// "2.874592e-12"). Core math stays exact in big.Rat; only the final display
// value becomes a float64.
func formatAmount(raw *big.Int, decimals int) string {
	denom := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	r := new(big.Rat).SetFrac(raw, denom)
	f, _ := r.Float64()
	return formatFloatLikePython(f)
}

// formatAmountRat is like formatAmount but for an already-rational raw value
// (used for LP exposure, which is a ratio and not an integer).
func formatAmountRat(raw *big.Rat, decimals int) string {
	denom := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	r := new(big.Rat).Quo(raw, denom)
	f, _ := r.Float64()
	return formatFloatLikePython(f)
}

func formatFloatLikePython(f float64) string {
	s := strconv.FormatFloat(f, 'g', -1, 64)
	// Python's repr always shows a decimal point for floats.
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}

func ensureDir(path string) error { return os.MkdirAll(path, 0o755) }

// writeCSV writes header + rows to path (creating parent dirs).
func writeCSV(path string, header []string, rows [][]string) error {
	if err := ensureDir(filepath.Dir(path)); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()
	if err := w.Write(header); err != nil {
		return err
	}
	return w.WriteAll(rows)
}

// readCSV reads a CSV returning header and rows.
func readCSV(path string) ([]string, [][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	recs, err := r.ReadAll()
	if err != nil {
		return nil, nil, err
	}
	if len(recs) == 0 {
		return nil, nil, nil
	}
	return recs[0], recs[1:], nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

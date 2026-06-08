package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// uploadCSVRequest is the body for Dune's CSV upload endpoint.
// Docs: POST https://api.dune.com/api/v1/table/upload/csv
type uploadCSVRequest struct {
	TableName   string `json:"table_name"`
	Description string `json:"description"`
	Data        string `json:"data"`
	IsPrivate   bool   `json:"is_private"`
}

// UploadToDune pushes a CSV file to Dune as a single table. On success the table
// is queryable as dune.<your_handle>.<table_name>.
func UploadToDune(cfg *Config) error {
	if cfg.DuneKey == "" {
		return fmt.Errorf("DUNE_API_KEY (or --dune-key) is required")
	}
	csvPath := cfg.CSVPath
	if csvPath == "" {
		csvPath = filepath.Join(cfg.OutDir, "dune_tea_claimers.csv")
	}
	raw, err := os.ReadFile(csvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", csvPath, err)
	}

	body, _ := json.Marshal(uploadCSVRequest{
		TableName:   cfg.DuneTable,
		Description: "TEA ignition claimers snapshot (claimed, TEA_LP, TEA_Hold, outflow) reproduced from Base RPC",
		Data:        string(raw),
		IsPrivate:   cfg.DunePrivate,
	})

	req, _ := http.NewRequest("POST", "https://api.dune.com/api/v1/table/upload/csv", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Dune-Api-Key", cfg.DuneKey)

	client := &http.Client{Timeout: 120 * time.Second}
	fmt.Printf("uploading %s (%d KB) as table %q (private=%t)...\n", csvPath, len(raw)/1024, cfg.DuneTable, cfg.DunePrivate)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("dune upload failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}
	fmt.Printf("✅ uploaded. Dune response: %s\n", string(respBody))
	fmt.Printf("Query it on Dune as:  dune.<your_handle>.%s\n", cfg.DuneTable)
	return nil
}

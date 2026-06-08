# $TEA Claimers Snapshot Reproducer

A zero-dependency Go CLI that builds an **AORA-style claimers snapshot dataset**
for **$TEA** on **Base** (TEA is bridged to Base via Hyperlane), ready to upload
to Dune. It is adapted from the original Aerodrome AORA reproducer; see
[What changed (TEA adaptation & fixes)](#what-changed-tea-adaptation--fixes) for
the full revision log.

It is **snapshot-based**, not transfer-trace-based. For each snapshot block and
each qualifying wallet it measures *remaining* TEA exposure and derives outflow
by subtraction:

```
claimed   = cumulative TEA claimed from the VotingReward up to this block   (ramps over time)
TEA_Hold  = TEA.balanceOf(wallet) / 1e18                                     (direct holdings)
TEA_LP    = wallet's TEA-side amount of its gauge-staked CL position / 1e18  (LP exposure)
outflow   = claimed - TEA_Hold - TEA_LP                                      (everything else)
```

## The TEA deployment it tracks

| Thing | Value |
|---|---|
| Chain | Base |
| TEA token | `0xa1a0b2e02b0e6830ad5a4a7211691200945d8919` (18 decimals) |
| Bribe / VotingReward | `0xe3460df40a682175972781a1b1330eaba3542118` |
| Pool (CL / Slipstream) | `0xabe1f289107c20081f591bb3972b8289add64f6c` — **USDC/TEA** |
| Pool ordering | **token0 = USDC, token1 = TEA** (the tool detects the side automatically) |
| Block range | `46870929` → `47050128`, step `3600` (≈ 50 snapshots) |
| Claimer source | `data/tea_claimers.csv` |
| Filter | wallets with **total claimed > 1,000,000 TEA** (`MIN_CLAIMED`) |

> **TEA_LP is concentrated-liquidity (v3) math.** TEA's pool is a Slipstream
> CL200 USDC/TEA pool — there is no v2 `getReserves`/LP-token formula. Each
> wallet's liquidity lives in NFT positions with a tick range; the TEA amount is
> derived from the position's liquidity, its `[tickLower, tickUpper]`, and the
> pool's current price (`slot0`) using Uniswap-V3 `LiquidityAmounts` math
> (`v3math.go`). Because TEA is **token1**, the tool reports the `amount1` side.
> Only **gauge-staked** positions are counted by default (`LP_STAKED_ONLY=true`).

## Quick start

```bash
# 0. Set BASE_RPC in .env to your Alchemy (archive) endpoint.

# 1. Build the deduped claimer list from the reference CSV — instant, no RPC.
go run . import-claimers --reference ./data/tea_claimers.csv

# 2. Resolve the pool's token0/token1 + CL gauge (one eth_call).
go run . discover-pools

# 3. Snapshot the full range. Balances need an ARCHIVE node (Alchemy).
#    Claim events are scanned once and cached (see provider note below).
go run . snapshots --start-block 46870929 --end-block 47050128 --step 3600

# 4. Merge every block into one upload-ready CSV.
go run . export-dune        # -> data/dune_tea_claimers.csv
```

Then upload `data/dune_tea_claimers.csv` to Dune (see [Uploading to Dune](#uploading-to-dune)).

## Provider note: archive vs `eth_getLogs` (important)

Two different RPC capabilities are needed, and **no single free tier does both well**:

| | Historical balances (archive) | `eth_getLogs` range |
|---|---|---|
| **Alchemy free** | ✅ yes — needed for snapshots | ❌ hard **10-block** cap (any contract) |
| **base.publicnode.com** | ⚠️ recent state only | ✅ wide (~16k-block ranges) |
| **base drpc / mainnet.base.org** | — | ~10k-block cap |

- **Snapshots** (`balanceOf`, CL positions) read old blocks → use **Alchemy** (`BASE_RPC` in `.env`).
- **The cumulative-claimed event scan** must sweep the whole range. On Alchemy's
  10-block cap that's ~18,000 requests (~40 min); on `base.publicnode.com` it's
  ~18 requests (~10 s). The scan is **cached** to `data/cache/claim_events.json`,
  so you only pay it once. To use the fast path for the scan, run the snapshot
  command with `--rpc https://base.publicnode.com` **once** to populate the cache
  (the snapshot reads will reuse on-disk checkpoints, so they don't need archive
  for an already-computed range), or just let it run on Alchemy if you don't mind
  the wait.

The TEA claim events are filtered server-side by the indexed `reward` topic
(`reward = TEA`), which keeps each response tiny.

## Commands

```bash
# Build claimers.csv from the reference CSV (dedup + >MIN_CLAIMED). No RPC.
go run . import-claimers --reference ./data/tea_claimers.csv

# Resolve pool token0/token1 + gauge from POOLS (no log scan).
go run . discover-pools

# One snapshot -> data/snapshots/wallets_block_<block>.csv
go run . snapshot --block 47050128

# A range of snapshots + time series (data/timeseries.csv)
go run . snapshots --start-block 46870929 --end-block 47050128 --step 3600

# Merge all snapshots into one Dune-ready CSV (plain decimals)
go run . export-dune

# Rebuild timeseries.csv from snapshot CSVs already on disk (offline)
go run . aggregate

# Inspect raw ClaimRewards logs to confirm topic layout
go run . debug-logs --from 46871000 --to 46871009
```

Snapshots and the claim-event scan are **cached** and reused on re-runs; pass
`--force` to recompute snapshots from scratch (e.g. after changing the claimer
set or `MIN_CLAIMED`).

## Uploading to Dune

1. **Upload** `data/dune_tea_claimers.csv` via Dune → *Create → Upload data*.
   Use a **fresh table name** (e.g. `tea_claimers`) — re-uploading over an
   existing table keeps the old column types.
2. **Query** it joined to block times, aggregating per block:

```sql
SELECT
  b.time AS block_time,
  SUM(d.tea_lp)   AS tea_lp,
  SUM(d.tea_hold) AS tea_hold,
  SUM(d.outflow)  AS outflow
FROM dune.<your_handle>.tea_claimers d
JOIN base.blocks b ON b.number = d.block
GROUP BY 1
ORDER BY 1
```

3. **Chart:** stacked area, X = `block_time`, Y = `tea_lp`, `tea_hold`, `outflow`.
   The `claimed`/"All" envelope (and `outflow`) ramps up from 0 — the AORA shape.

> The `SUM(...) GROUP BY block_time` is essential. The CSV has one row per wallet
> per block; plotting it without aggregation overlays 167 wallets per timestamp
> and looks chaotic.

## Outputs

| File | Columns |
|---|---|
| `data/claimers.csv` | `wallet,claimed_raw,claimed_decimal` (one row per **distinct** wallet) |
| `data/pools.csv` | `pool,token0,token1,stable` |
| `data/snapshots/wallets_block_<block>.csv` | `wallet,partner,claimed,TEA_LP,TEA_Hold` |
| `data/timeseries.csv` | `block,timestamp,claimed,lp,hold,outflow` |
| `data/dune_tea_claimers.csv` | `block,timestamp,wallet,partner,claimed,TEA_LP,TEA_Hold,outflow` |
| `data/cache/claim_events.json` | cached ClaimRewards(reward=TEA) events for cumulative claimed |

**Number formatting:** the Dune export writes **plain decimals** (never
scientific notation). Scientific notation like `1.7e+08` makes Dune's uploader
infer the column as text, which breaks `SUM`/sort in charts. Core math stays
exact in `big.Int`/`big.Rat`; only the final display value becomes a float.

## What changed (TEA adaptation & fixes)

This started as the AORA tool. The revisions below were made to adapt it to TEA
and to fix several real bugs surfaced while reproducing the chart.

### Adaptation
- **Token/contracts → TEA.** New defaults for the token, bribe, and pool;
  `TEA_TOKEN` / `TEA_DECIMALS` env vars (legacy `AORA_*` still accepted as
  fallback); the token flag is `--token`.
- **token1 handling.** USDC is token0 and TEA is token1; `TEA_LP` automatically
  uses the token1 (`amount1`) side — no code change needed, just verified.
- **Output relabelled** `AORA_LP`/`AORA_Hold` → `TEA_LP`/`TEA_Hold`; Dune table
  `tea_claimers`; export file `dune_tea_claimers.csv`.

### Bug fixes
1. **Scientific notation broke Dune typing.** Values like `1.72e+08` were stored
   as text → unsortable, "spiky" chart. `export-dune` now emits plain
   fixed-decimal numbers.
2. **`ClaimRewards` was decoded wrong.** On-chain the event is
   `ClaimRewards(address indexed from, address indexed reward, uint256 amount)` —
   `reward` is an **indexed topic** (`topic[2]`), and `amount` is in `data[0]`.
   The original code read `reward`/`amount` from the data words, so it dropped
   every event. Fixed the decode **and** added a server-side `reward = TEA` topic
   filter (which also enables the wide-range fast scan). *(This latent bug was in
   the original `ScanClaims` too — both paths are fixed.)*
3. **Duplicate wallet rows inflated cumulative claimed.** `tea_claimers.csv` lists
   some wallets on multiple rows (one per claim/epoch — 168 distinct wallets
   across 219 rows). The fixed-total method summed those rows correctly by luck,
   but cumulative-claimed assigns each *row* the wallet's full per-block total, so
   a wallet listed 5× was counted 5× (total ballooned to 2.64B, above the 1.69B
   of all on-chain claims). `import-claimers` now **aggregates per distinct
   wallet** before the `MIN_CLAIMED` filter.

### Feature: cumulative claimed (AORA-style ramp)
- The original reproducer stamped each wallet's **fixed lifetime total** onto
  every block, so the `claimed` envelope was flat and the entire amount dumped
  into the first block's `outflow`.
- Now `claimed(wallet, block)` is the sum of that wallet's on-chain `ClaimRewards`
  **up to that block**, so `claimed`/`outflow` ramp naturally like the AORA
  dataset. Toggle with `--cumulative` (default `true`) / `CUMULATIVE_CLAIMED`.
  When enabled, cached snapshot checkpoints (which hold the expensive balance/LP
  reads) are reused and only `claimed` is recomputed — no extra balance RPC.

### Config
- `MIN_CLAIMED=1000000` — include only wallets whose **total** claimed exceeds
  1M TEA (a `GROUP BY wallet HAVING SUM(...) > 1e6`).

## Performance: batching with Multicall3

The tool **never makes one RPC call per wallet**. It uses **Multicall3**
(`0xcA11bde05977b3631167028862bE2a173976CA11` on Base) via `aggregate3`, invoked
through `eth_call` at a historical block tag so every sub-call is evaluated
against that block's state. For W wallets and P pools a snapshot is a few batched
requests instead of `W·(1+P)`. Tune `MULTICALL_BATCH` (default 500); set
`USE_MULTICALL=false` to fall back to plain `eth_call`s.

## Caching & resume

- `claimers`, `pools`, and the **claim-event scan** are cached and reused unless
  inputs change (`--force` for snapshots).
- Each snapshot block writes a lossless JSON checkpoint to
  `data/cache/block_<block>.json` (raw `big.Int` holds + `big.Rat` LP + block
  timestamp). Re-runs load completed blocks with **zero RPC**.
- `aggregate` rebuilds `timeseries.csv` fully offline.

## Why no external dependencies

Pure Go standard library plus a self-contained, unit-tested Keccak-256
(`keccak.go`). Function selectors and event topics are **derived** from their
signatures at startup (no magic numbers), so `go build` / `go run` work fully
offline.

Verified topics (cross-checked in `keccak_test.go`):

| Signature | topic0 / selector |
|---|---|
| `ClaimRewards(address,address,uint256)` | `0x9aa05b3d…e2efc9` |
| `PoolCreated(address,address,bool,address,uint256)` | `0x2128d88d…065005e` |
| `balanceOf(address)` | `0x70a08231` |

## Source layout

| File | Responsibility |
|---|---|
| `main.go` | CLI dispatch, `aggregate`, `export-dune`, claim-event wiring |
| `config.go` | `.env` + env + flag resolution (TEA defaults, `--cumulative`, `--token`) |
| `rpc.go` | JSON-RPC client: rate limit, retry, `eth_call`/`eth_getLogs`/blocks |
| `multicall.go` | Multicall3 `aggregate3` ABI encode/decode + batched reads |
| `abi.go` | minimal ABI encode/decode, selector/topic derivation, topic filters |
| `keccak.go` | self-contained Keccak-256 |
| `claims.go` | ClaimRewards scan/aggregation; cumulative claimed; deduped `import-claimers` |
| `pools.go` | pool discovery (PoolCreated) / manual pools |
| `v3math.go` | Uniswap-V3 TickMath + LiquidityAmounts (CL position → token amounts) |
| `v3pos.go` | CL position discovery (gauge-staked + NFTs) and batched LP per wallet |
| `snapshot.go` | per-block Hold + CL LP exposure, cumulative-claimed apply, outputs |
| `csv.go` | CSV read/write + decimal formatting |
| `dune.go` | Dune CSV upload helper |
| `validate.go` | join generated vs reference, report diffs |

## Reusing this for another token

👉 **See [`ADAPTING.md`](ADAPTING.md)** for the full template guide — it splits the
work into *env-only* changes and *code-level* changes you must verify (the claim
event decode, CL gauge resolution), with a per-project checklist.

Every address is configurable — point `.env` at new contracts:

1. Set `BASE_RPC` (archive), `TEA_TOKEN` (reward token), `VOTING_REWARD` (bribe),
   `POOLS` (v2 *or* CL pool), and `MIN_CLAIMED` / block range.
2. `go run . import-claimers --reference <file>` (or `go run . claims` to scan
   on-chain — needs a wide-`getLogs` provider; see the provider note).
3. `go run . snapshots ...`, then `go run . export-dune` and upload.

Token decimals, pool type (v2 vs CL), and token0/token1 ordering are all detected
or configurable.

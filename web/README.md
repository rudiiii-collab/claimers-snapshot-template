# Claimers Snapshot — web app

A customizable web UI for the claimers-snapshot pipeline in this repo: fill a
form (token, bribe, pools, block range, filter), hit **Run**, get the classic
stacked-area chart (`LP` / `Hold` / `outflow` with the cumulative `claimed`
ramp), a per-wallet table, and a Dune-ready CSV download.

**All compute runs in your browser** — an exact BigInt port of the Go pipeline
(claim-event scan, Multicall3 batching, Uniswap-V3/Slipstream CL math). RPC
keys never leave the page; results are cached in IndexedDB so re-runs and
interrupted runs resume instantly. See [`../docs/architecture.md`](../docs/architecture.md)
for why this beats a Worker-side design on the Cloudflare free tier.

## Run locally

No build step, no dependencies. Either:

```bash
cd web
npx wrangler pages dev          # serves public/ + the /api/rpc proxy function
```

or any static server (`python -m http.server -d public 8788`) — the proxy
function is optional (only needed for RPC endpoints without CORS).

## Deploy to Cloudflare (free)

```bash
cd web
npx wrangler pages deploy       # first run: creates the Pages project
```

That's it — static assets on Pages (free, unlimited requests) plus one
optional Pages Function (`/api/rpc`, free 100k requests/day, used only as a
CORS fallback). Total cost: **$0**.

## Using the app

The form maps 1:1 to the pipeline's `.env`:

| Field | `.env` equivalent | Notes |
|---|---|---|
| Chain | — | Base preset fills factory/voter/logs RPC |
| Archive RPC | `BASE_RPC` | **required for historical blocks** — Alchemy free has archive on Base |
| Logs RPC | (`--rpc` override) | wide-range `eth_getLogs`; default `base.publicnode.com` |
| Token contract | `TEA_TOKEN` | "Auto-detect" fills decimals + symbol via `decimals()`/`symbol()` |
| Token decimals | `TEA_DECIMALS` | |
| Bribe / VotingReward | `VOTING_REWARD` | the contract emitting `ClaimRewards` |
| Pool(s) | `POOLS` | comma-separated; v2 vs CL and token0/token1 auto-detected. "Discover pools" scans `PoolCreated` on the factory |
| Block range / step | `START_BLOCK`/`END_BLOCK`/`STEP_BLOCKS` | step 3600 ≈ 2 h on Base |
| Min claimed | `MIN_CLAIMED` | wallets with **total** claimed > threshold (deduped first) |
| Claimer source | `import-claimers` / `claims` | upload a reference CSV **or** scan claim events on-chain |
| Advanced → staked-only, cumulative, chunk, batch, rate | `LP_STAKED_ONLY`, `CUMULATIVE_CLAIMED`, `CHUNK_BLOCKS`, `MULTICALL_BATCH`, `RATE_PER_SECOND` | same defaults |

First visit pre-fills the **$TEA on Base** example from the repo README.

### Provider note (same as the Go tool)

Two RPC capabilities are needed: **historical balances** need an archive node
— that's the Archive RPC field; the **claim-event scan** sweeps the whole
range and needs wide `eth_getLogs` — that's the Logs RPC field. The scan
result is cached locally, so you pay it once per config.

Provider landscape as verified **August 2026** (this shifts — the app's
range-shrink logic adapts automatically):

| Endpoint | Archive `eth_call` | `eth_getLogs` range |
|---|---|---|
| `mainnet.base.org` (keyless default) | ✅ works | 10,000-block cap (fine: ~18 requests per 180k-block scan) |
| Alchemy free (your key) | ✅ works | ❌ ~10-block cap — don't use it as the Logs RPC |
| `base.publicnode.com` | ❌ now requires a (free) personal token for anything non-recent | — |

`mainnet.base.org` is rate-limited; the app's default 8 req/s + retry/backoff
copes, but bring an Alchemy key as the Archive RPC for heavy or repeated runs.

### Caching semantics

- Claim events cache per (bribe, reward, range, event signature).
- Per-block checkpoints hold the expensive balance/LP reads, scoped by
  (token, pools, staked-only, claimer set) — changing `MIN_CLAIMED` or the
  claimer CSV invalidates them automatically; toggling *cumulative* reuses
  them with zero RPC, exactly like the Go tool.
- "Force recompute" ignores caches; "Clear cache" wipes them.

## Tests

```bash
node web/test/run-tests.mjs
```

Verifies the JS port value-for-value against the Go implementation (expected
values generated with `go test -run TestOracle -v`): keccak selectors/topics,
TickMath across the full tick range, `positionAmounts`, Multicall3 ABI
encoding/decoding, claimer dedupe + `MIN_CLAIMED`, cumulative-claimed ramps,
and the plain-decimal CSV rules (never scientific notation — Dune's uploader
types `1.7e+08` columns as VARCHAR, which silently breaks SUM/sort).

## Free-tier limits that matter

- Pages static assets: free, unlimited requests.
- `/api/rpc` proxy: Pages Functions free tier = 100k requests/day — only
  consumed when an endpoint blocks CORS (the defaults don't).
- Your RPC providers are the real limit: Alchemy free ≈ 300 CU/s (a 50-block
  run is a few hundred `eth_call`s at the app's default 8 req/s), publicnode
  is rate-limited but the scan is ~20 requests. The rate slider is in
  Advanced if a provider complains.

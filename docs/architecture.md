# Architecture Decision — Claimers Snapshot Web App

**Decision: Option D (browser-side compute) on Cloudflare Pages, with a thin
optional Pages Function as a CORS-proxy escape hatch (a small slice of Option B).
No Worker does any pipeline compute.**

## The workload, measured

Before choosing, the constraint that matters is the *shape* of a run. For the
reference TEA config (168 wallets, 1 CL pool, 50 snapshot blocks):

| Stage | Upstream RPC calls |
|---|---|
| Claim-event scan (cached once per config) | ~4–18 `eth_getLogs` on a wide-range endpoint |
| Per snapshot block: pool state + CL passes + wallet balances via Multicall3 | ~4–6 `eth_call` + 1 `eth_getBlockByNumber` |
| **Full 50-block run** | **~250–350 requests** |

CPU is negligible: it is BigInt arithmetic over a few hundred positions/wallets
per block — milliseconds. The pipeline is **network-bound**, not compute-bound.

## Options considered

### A — Full TypeScript rewrite inside a Worker ❌
The Workers **free** tier allows **50 subrequests per invocation** and ~10 ms
CPU. A run needs 250–350 upstream calls, so one invocation can never finish a
job. You must shard the job across many invocations with state in KV and a
client polling loop — i.e. the *client* ends up driving the loop anyway, but
now with an extra distributed-state layer, KV write quotas (1k writes/day free),
and every user sharing one 100k req/day budget. All cost, no benefit.

### B — Worker API + queued/cron compute ❌ (as primary)
Cloudflare **Queues requires the paid Workers plan**, and Cron Triggers fire on
a schedule — wrong shape for user-triggered runs. Durable Objects exist on free
but the 50-subrequest cap still applies per invocation. Caching results in
KV/R2 is nice but doesn't solve compute placement. Rejected as the primary,
**kept as an escape hatch**: a stateless Pages Function CORS proxy (below).

### C — Reuse the Go CLI ❌
Workers can't run native binaries; Cloudflare Containers and any always-on
runner are **not free tier**. Go→WASM of a CLI that expects a filesystem,
goroutines and long wall-clock runs inside a Worker is the worst of both
worlds. Rejected — the Go repo stays what it is: the **test oracle**.

### D — Browser-side compute on static Pages ✅
Everything the Go tool does over HTTP JSON-RPC, a browser tab can do:

- **No subrequest/CPU caps.** The tab makes 300 requests at a polite rate
  (default 8 req/s, same as the Go tool) — a full 50-block run is ~1–3 min,
  with live progress.
- **Same caching semantics as the Go tool.** `data/cache/block_<n>.json`
  checkpoints → IndexedDB records keyed by a config hash; claim-event cache →
  one IndexedDB record per (bribe, reward, range). Interrupted runs resume;
  re-running an identical config is instant; toggling only `MIN_CLAIMED` or
  the claimer set reuses cached balance reads exactly like the Go tool.
- **User RPC keys never leave the browser** (stored in `localStorage`, sent
  only to the RPC provider). Better privacy than any server-side design.
- **$0 forever.** Static assets on Pages free tier have unlimited requests.

**The two-RPC reality is a first-class UI concept.** Mirroring the repo's
provider note, the form has two endpoint fields:

| Field | Used for | Default |
|---|---|---|
| Archive RPC | `eth_call` at historical blocks (balances, slot0, positions) | `https://mainnet.base.org` (verified Aug 2026: serves archive state keyless; user's Alchemy key recommended for heavy runs) |
| Logs RPC | wide-range `eth_getLogs` claim scan | `https://mainnet.base.org` (10k-block cap ⇒ ~18 requests per scan) |

*(The repo README's provider table predates a policy change: `base.publicnode.com`
now requires a free personal token for anything non-recent, so it is no longer
a usable keyless default. Verified empirically during this build.)*

### The escape hatch: `/api/rpc` Pages Function
Both default providers (Alchemy, publicnode) send CORS headers to browsers. If
a user brings an endpoint that doesn't, the app retries through
`POST /api/rpc?url=<endpoint>` — a ~30-line stateless passthrough (https-only,
JSON-RPC body forwarded verbatim, **no logging of URLs or bodies**). Pages
Functions free tier is 100k requests/day, which only ever gets spent for
non-CORS endpoints.

## Assumptions stated explicitly (per the brief)

1. **Free-tier numbers assumed:** Workers/Pages Functions free = 100k req/day,
   10 ms CPU, **50 subrequests per invocation**; KV free = 1k writes/day;
   Queues and Containers = paid only; Pages static = unlimited free requests.
   If the 50-subrequest figure is wrong (it is the published free-tier limit as
   of early 2026), option A is still worse than D on quota-sharing grounds alone.
2. **CORS:** Alchemy and publicnode both allow browser origins. Verified at
   runtime during E2E testing; the proxy exists precisely in case a provider
   changes this.
3. **publicnode is not archive.** Snapshots of *old* blocks require the user's
   own archive endpoint (Alchemy free). The UI labels this clearly instead of
   pretending a public default can do it.
4. **Rounding:** the JS port keeps all integer math in `BigInt`. The one
   deviation from Go: v2-pool LP (`lpBal·reserve/totalSupply`) uses floor
   division instead of exact `big.Rat` — an error of < 1 wei per (wallet,
   pool), far below the float64 rounding the Go exporter itself applies at
   CSV time. CL math (TickMath / LiquidityAmounts) is ported exactly —
   integer-for-integer.
5. **Claim-event decode** assumes the Aerodrome/Velodrome
   `ClaimRewards(address indexed from, address indexed reward, uint256 amount)`
   layout, same as the repo. The form exposes the event signature as an
   advanced field (topic0 is derived via an in-browser Keccak-256, verified
   against the repo's `keccak_test.go` vectors), but non-standard *layouts*
   (Merkle `Claimed(...)` etc.) remain a code-level change — same boundary as
   `ADAPTING.md` Tier 2.

## What Cloudflare free tier cannot do

Run this pipeline *server-side* on demand. Anything beyond a ~50-call job per
invocation needs the paid plan (Queues/Containers/more CPU). The browser is not
a workaround — it is genuinely the better placement for a network-bound,
user-keyed, bursty workload. Cost: **$0**.

## Component map

```
web/
  public/            → Cloudflare Pages (static, free)
    index.html         form (1:1 with the config table) + chart + table
    js/keccak.js       Keccak-256 (verified vs keccak_test.go)
    js/abi.js          selectors/topics/encode/decode (port of abi.go)
    js/rpc.js          rate-limited retrying client + getLogs range-shrink (rpc.go)
    js/multicall.js    aggregate3 encode/decode (multicall.go)
    js/v3math.js       TickMath + LiquidityAmounts, exact BigInt (v3math.go)
    js/v3pos.js        CL pool/gauge/position discovery, 3-pass batching (v3pos.go)
    js/claims.js       event scan, cumulative claimed, CSV import (claims.go)
    js/pools.js        manual pool resolve + PoolCreated discovery (pools.go)
    js/snapshot.js     per-block Hold+LP+claimed, totals (snapshot.go)
    js/pipeline.js     job runner: config → series, progress, cancel, resume
    js/store.js        localStorage config + IndexedDB checkpoints
    js/csv.js          plain-decimal export (never scientific — the Dune bug)
    js/chart.js        stacked-area SVG (lp / hold / outflow)
    js/main.js         UI wiring
  functions/api/rpc.js → optional CORS proxy (Pages Function, free)
  test/              → Node unit tests for the math ports
  wrangler.toml      → `wrangler pages dev` / `wrangler pages deploy`
```

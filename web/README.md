# Aero MetaDEX03 Incentive Claimers Snapshot — web app

A browser UI for building an **incentive-only** claimers snapshot from Aero
MetaDEX03 on Base. It discovers matching `IncentiveCreated` programs, counts
only `ClaimIncentives` events (`ClaimFees` are excluded), and produces the
stacked-area chart (`LP` / `Hold` / `Outflow` attributed to cumulative
`claimed`, with a `Retained` / `Outflow` toggle), a
per-wallet table, and a Dune-ready CSV download.

All compute runs in the browser with exact `BigInt` arithmetic. Historical
balances and Aero CL positions come from the configured RPC endpoints; results
are cached in IndexedDB so interrupted runs can resume.

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

The form is prefilled with the RSGP incentive program example:

| Field | Notes |
|---|---|
| Chain | Base preset fills Aero CLFactory and separate archive/logs RPCs |
| Archive RPC | Historical `eth_call` for token balances and CL positions |
| Logs RPC | Wide-range `eth_getLogs` for program discovery and incentive claims |
| Token contract / decimals / symbol | Tracked incentive token; auto-detect fills metadata |
| VotingRewardsManager | Contract emitting `IncentiveCreated` and `ClaimIncentives` |
| Pool(s) | Comma-separated Aero CL pools; token side is auto-detected |
| Block range / step | Claim/snapshot window and snapshot spacing |
| Program scan start block | Optional earlier manager block for programs created before the claim window; must be ≤ start block |
| Min claimed | Include wallets whose total incentive claims exceed this threshold |
| Claimer source | Scan onchain events or upload an incentive-only reference CSV |
| Advanced controls | Staked-only LP, cumulative claimed, log chunk, Multicall batch, and rate limit |

The bundled Base preset uses RSGP, its VotingRewardsManager, and its Aero CL
RSGP/USDC pool. `ClaimFees` never contribute to `claimed`.

### Claim attribution and chart percentages

Raw wallet LP + Hold can exceed claimed because wallets may acquire the token
outside the incentive claim. The chart therefore attributes claimed tokens per
wallet instead of netting signed residuals across wallets:

```text
exposure = raw LP + raw Hold
retained = min(claimed, exposure)
outflow  = claimed - retained
LP attributed   = retained * raw LP / exposure
Hold attributed = retained - LP attributed
```

If exposure is zero, the wallet's full claimed amount is Outflow. This preserves
`LP attributed + Hold attributed + Outflow = claimed` exactly for every wallet.
Displayed percentages use exact basis-point remainder allocation and always sum
to 100.00%. Raw LP/Hold and exposure above claims remain visible in tooltips and
CSV exports; they are not mislabeled as claimed-token percentages.

The Dune CSV exports explicit `*_raw`, `*_attributed`, `retained`, `outflow`,
and `excess_exposure` columns. Outflow is non-negative and computed per wallet,
so one wallet's excess exposure never cancels another wallet's outflow.

### Provider note

Two RPC capabilities are needed: historical balances/positions use the
**Archive RPC**, while program/claim scans use wide-range `eth_getLogs` through
the **Logs RPC**. The current defaults split those jobs:

- Archive RPC: `mainnet.base.org`
- Logs RPC: `base-rpc.publicnode.com`

A live integration run over blocks 53,171,524–53,275,371 completed through
PublicNode in 12 requests. Provider limits can change, so the log scanner
shrinks rejected ranges automatically and both endpoints remain editable.

### Caching semantics

- Incentive events are cached per version, authoritative RPC `eth_chainId`,
  logs endpoint, manager, token, program-discovery start, claim start, and claim
  end.
- Per-block checkpoints hold expensive balance/LP reads. Their namespace is
  migration-versioned and scoped by authoritative RPC `eth_chainId`, UI chain
  label, archive RPC, token, pools, staked-only mode, and claimer set.
- Runs stop early if Logs RPC and Archive RPC report different chain IDs.
- Changing `MIN_CLAIMED` or the claimer CSV invalidates the relevant checkpoint
  scope; toggling cumulative mode can reuse hold/LP data.
- **Force recompute** ignores caches; **Clear cache** wipes them.

## Tests

```bash
node web/test/run-tests.mjs
```

The suite covers keccak selectors/topics, TickMath, CL position math,
Multicall3 ABI encoding, incentive-only program/claim filtering, signed Aero
CLFactory tick spacing, direct `pool.gauge()`/`gauge.nft()` resolution, UI
config migration, cumulative claims, and plain-decimal CSV output.

## Free-tier limits that matter

- Pages static assets: free, unlimited requests.
- `/api/rpc` proxy: Pages Functions free tier = 100k requests/day — only
  consumed when an endpoint blocks CORS (the defaults don't).
- Your RPC providers are the real limit: Alchemy free ≈ 300 CU/s (a 50-block
  run is a few hundred `eth_call`s at the app's default 8 req/s), publicnode
  is rate-limited but the scan is ~20 requests. The rate slider is in
  Advanced if a provider complains.

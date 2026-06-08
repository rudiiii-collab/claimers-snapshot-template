# Adapting this template to a new project / token

This repo is a reusable pipeline that produces an **AORA-style claimers snapshot
dataset** for any token on an EVM chain, ready to upload to Dune:

```
claimed  = cumulative reward claimed up to each block   (ramps over time)
<TKN>_Hold = token.balanceOf(wallet)                    (direct holdings)
<TKN>_LP   = wallet's token-side amount in the LP pool  (v2 reserves OR CL position)
outflow  = claimed - Hold - LP                          (everything else)
```

It currently ships configured for **$TEA on Base** as a working example. To track
a different project, most changes are **just `.env`** — but a few are **code-level
and must be verified**, because they depend on *which DEX / distribution contract*
the project uses. Read both tiers below.

---

## Tier 1 — Env-only changes (the common case)

Copy `.env.template` → `.env` and set these. Everything here is also a CLI flag.

| Variable | What it is | How to find it |
|---|---|---|
| `BASE_RPC` | Archive RPC for the chain | Alchemy free (archive on Base/most chains) |
| `TEA_TOKEN` | **The reward token** you're tracking | Token contract on the explorer / Dexscreener |
| `VOTING_REWARD` | **The contract that emits the claim event** (bribe / distributor / MerkleClaim) | The contract wallets call to claim; check its event logs |
| `POOLS` | The token's liquidity pool address(es) | Dexscreener / the DEX. v2 **or** concentrated-liquidity both supported |
| `AERODROME_FACTORY` / `AERODROME_VOTER` | DEX factory + voter (only needed for CL gauge resolution) | DEX docs |
| `TEA_DECIMALS` | Token decimals | `decimals()` on the token (usually 18, USDC-likes 6) |
| `MIN_CLAIMED` | Minimum **total** claimed to include a wallet | Your call (e.g. `1000000` = >1M) |
| `START_BLOCK` / `END_BLOCK` / `STEP_BLOCKS` | Snapshot window + cadence | Launch block → now; `3600` ≈ a couple hours on Base |
| `LP_STAKED_ONLY` | Count only gauge-**staked** CL positions | `true` to match the Dune methodology |
| `CUMULATIVE_CLAIMED` | Ramp claimed per block from events | `true` (set `false` to stamp a fixed lifetime total) |

> **token0 / token1 ordering is auto-detected.** You do **not** configure which
> side is your token. `discover-pools` reads `token0()`/`token1()` and the tool
> reports the correct side (for TEA the pool is USDC/TEA with TEA as token1).

> **Pool type (v2 vs CL) is auto-detected.** If the pool exposes `slot0()` it's
> treated as concentrated-liquidity (Uniswap-V3/Slipstream math); otherwise it's
> a v2 pool read via `getReserves()`/LP-token supply.

### Claimer source
- **Have a reference CSV** (wallet + claimed amount, one or many rows per wallet)?
  `go run . import-claimers --reference ./data/<your>.csv` — it dedupes per wallet
  and filters by `MIN_CLAIMED`. No RPC.
- **No CSV?** `go run . claims` scans the claim event on-chain (needs the Tier-2
  event decode to be correct, and a wide-`getLogs` provider).

---

## Tier 2 — Code-level changes (verify these per project) ⚠️

These encode assumptions about the **Aerodrome/Velodrome** contracts. If the new
project uses a different DEX or a different distribution mechanism, you must
adapt them. **Always run `go run . debug-logs --from <b> --to <b+9>` first** to
see the real event layout before trusting the numbers.

### 1. The claim event signature + decode — `abi.go` + `claims.go` 🔴 most important
The tool assumes the Aerodrome `VotingReward`:
```solidity
event ClaimRewards(address indexed from, address indexed reward, uint256 amount);
// topic0 = sig, topic1 = from (wallet), topic2 = reward token, data[0] = amount
```
- `abi.go` → `topicClaimRewards = topic0("ClaimRewards(address,address,uint256)")`
- `claims.go` → `ScanClaims` **and** `ScanClaimEvents` decode `topic1` (wallet),
  filter `topic2` (reward), read `data[0]` (amount).

**If your distributor emits a different event** (e.g. a Merkle `Claimed(index,
account, amount)`, or `RewardPaid`, or `reward` is *not* indexed), you must:
1. Change the signature string in `abi.go`.
2. Update the topic/data indexing in both functions in `claims.go`.
3. Re-check the server-side topic filter (`addressTopic(cfg.AoraToken)` assumes
   reward is the indexed `topic2`; drop/move it if not).

> How to tell: run `debug-logs` over a small range that contains a claim and look
> at how many `topic[]` entries there are and where the amount sits.

### 2. Concentrated-liquidity position + gauge resolution — `v3pos.go`
Assumes Aerodrome Slipstream:
- gauge via `Voter.gauges(pool)`, NFT manager via `gauge.nft()`,
- staked token IDs via `gauge.stakedValues(wallet)`,
- `positions(tokenId)` decoded in the Slipstream field order.

A different CL DEX (Uniswap-V3 proper, PancakeSwap-V3, etc.) has a different
gauge/staking interface and sometimes a different `positions()` layout. If your
token only has a **v2** pool, none of this runs and you can ignore it.

### 3. CL math — `v3math.go`
Standard Uniswap-V3 `TickMath` + `LiquidityAmounts`. Works for any V3-style pool;
only revisit if the pool uses non-standard tick spacing/precision.

### 4. Pool discovery event — `pools.go`
`discover-pools` can scan `PoolCreated(...)` (Aerodrome factory signature). For a
different factory, either fix that signature or just set `POOLS` manually (the
recommended path — avoids the scan entirely).

---

## Provider note (applies to every project)

Two RPC capabilities are needed and no single free tier does both well:

| | Historical balances (archive) | `eth_getLogs` range |
|---|---|---|
| **Alchemy free** | ✅ snapshots | ❌ 10-block cap |
| **publicnode / public RPCs** | ⚠️ recent only | ✅ wide ranges |

- **Snapshots** (`balanceOf`, CL positions) need **archive** → Alchemy.
- **The cumulative-claimed event scan** sweeps the whole range; on Alchemy's
  10-block cap that's thousands of requests. Run the scan once against a
  wide-`getLogs` endpoint (e.g. `--rpc https://base.publicnode.com`) — it's cached
  to `data/cache/claim_events.json` and reused thereafter.

---

## Output labels (cosmetic)

The columns are named `TEA_LP` / `TEA_Hold` and the Dune table/file are
`tea_claimers` / `dune_tea_claimers.csv`. To rename per project, change the
literals in `snapshot.go` (CSV header), `main.go` (`export-dune` header + file
name + Dune table default in `config.go`), and `dune.go` (description).

---

## Checklist for a new project

```
[ ] .env: BASE_RPC, TEA_TOKEN, VOTING_REWARD, POOLS, *_DECIMALS, MIN_CLAIMED, block range
[ ] debug-logs over a claim → CONFIRM the event layout matches Tier-2 §1
[ ]   if not: fix abi.go signature + claims.go decode/topic-filter
[ ] discover-pools → CONFIRM token0/token1 + (if CL) gauge/nft resolved
[ ] import-claimers --reference <csv>  (or: claims)  → check distinct wallet count
[ ] snapshots over a SINGLE block first → sanity-check Hold and LP magnitudes
[ ] snapshots full range → export-dune → upload to Dune (fresh table name)
[ ] (optional) rename TEA_* output labels
```

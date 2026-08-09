// Per-block snapshot compute — port of snapshot.go.
//
// Dune-equivalent per-wallet formula at snapshot block b:
//   Hold    = token.balanceOf(wallet)                      (direct holdings)
//   LP      = Σ v2 pools (lpBal/totalSupply)*tokenReserve
//           + Σ CL pools token-side of positions (v3 math) (LP exposure)
//   claimed = cumulative ClaimRewards up to b (or fixed lifetime total)
//   outflow = claimed - Hold - LP                          (by subtraction)
//
// All integer math is BigInt. The only deviation from Go: v2 LP uses floor
// division instead of exact big.Rat — < 1 wei per (wallet, pool), far below
// the float64 rounding the Go exporter itself applies at CSV time.

import { sel, callDataBalanceOf, parseReserves } from './abi.js';
import { multiCall, resultUint } from './multicall.js';
import { loadCLPool, snapshotCLLP } from './v3pos.js';
import { cumulativeClaimed } from './claims.js';

/**
 * totalSupply + token-side reserve for each v2 pool at `block`, one Multicall3
 * request. CL pools revert on totalSupply/getReserves and are skipped here
 * (they're handled by the CL path).
 */
async function fetchPoolStates(client, cfg, pools, block) {
  if (!pools.length) return [];
  const calls = [];
  for (const p of pools) {
    calls.push({ target: p.address, data: sel.totalSupply });
    calls.push({ target: p.address, data: sel.getReserves });
  }
  const res = await multiCall(client, calls, block, cfg.multicallBatch);
  const states = [];
  for (let i = 0; i < pools.length; i++) {
    const ts = resultUint(res[i * 2]);
    if (ts === 0n) continue; // pool empty / not deployed at this block / CL pool
    const rr = res[i * 2 + 1];
    if (!rr.success) continue;
    const { reserve0, reserve1 } = parseReserves(rr.ret);
    states.push({
      pool: pools[i],
      totalSupply: ts,
      tokenReserve: pools[i].tokenIsToken0 ? reserve0 : reserve1,
    });
  }
  return states;
}

/** (lpBalance * tokenReserve) / totalSupply, floor. */
function lpFromBalance(lpBal, tokenReserve, totalSupply) {
  if (lpBal === 0n || totalSupply === 0n) return 0n;
  return (lpBal * tokenReserve) / totalSupply;
}

/** Probe configured pools; return those that are CL (expose slot0 with price). */
async function loadCLPools(client, cfg, pools, block) {
  const cl = [];
  for (const p of pools) {
    const clp = await loadCLPool(client, cfg, p.address, block);
    if (clp) cl.push(clp);
  }
  return cl;
}

/**
 * Compute one snapshot block: rows [{wallet, claimed, hold, lp}] (all BigInt
 * raw base units). `claimers` carry the fixed lifetime totals; when `events`
 * is non-null claimed is overridden with the cumulative-to-block amount.
 */
export async function computeSnapshot(client, cfg, claimers, pools, block, events, onProgress) {
  // Effective claimed per wallet at this block.
  let claimedOf = (cl) => cl.raw;
  if (events) {
    const cum = cumulativeClaimed(events, block);
    claimedOf = (cl) => cum.get(cl.wallet) || 0n;
  }

  const states = await fetchPoolStates(client, cfg, pools, block);
  const clPools = await loadCLPools(client, cfg, pools, block);
  const clLP = await snapshotCLLP(client, cfg, claimers, clPools, block);

  onProgress?.({
    note: `block ${block}: ${claimers.length} claimers, ${states.length} v2 pool(s), ` +
      `${clPools.length} CL pool(s), ${clLP.size} wallets with CL LP`,
  });

  // One token balanceOf + one balanceOf per v2 pool for every wallet, batched.
  const perWallet = 1 + states.length;
  const calls = [];
  for (const cl of claimers) {
    calls.push({ target: cfg.token, data: callDataBalanceOf(cl.wallet) });
    for (const st of states) {
      calls.push({ target: st.pool.address, data: callDataBalanceOf(cl.wallet) });
    }
  }
  const res = await multiCall(client, calls, block, cfg.multicallBatch);

  const rows = [];
  for (let i = 0; i < claimers.length; i++) {
    const cl = claimers[i];
    const base = i * perWallet;
    const hold = resultUint(res[base]);
    let lp = 0n;
    for (let p = 0; p < states.length; p++) {
      const st = states[p];
      lp += lpFromBalance(resultUint(res[base + 1 + p]), st.tokenReserve, st.totalSupply);
    }
    lp += clLP.get(cl.wallet) || 0n;
    rows.push({ wallet: cl.wallet, claimed: claimedOf(cl), hold, lp });
  }
  return rows;
}

/** Aggregate a snapshot's rows into time-series totals (BigInt raw sums). */
export function totalsFromRows(block, timestamp, rows) {
  let claimed = 0n, hold = 0n, lp = 0n;
  for (const r of rows) {
    claimed += r.claimed;
    hold += r.hold;
    lp += r.lp;
  }
  return { block, timestamp, claimed, hold, lp, outflow: claimed - hold - lp };
}

/**
 * Re-derive claimed for cached rows (checkpoint reuse: the expensive hold/LP
 * reads are kept; only claimed is recomputed from events — zero RPC).
 */
export function applyCumulativeClaimed(rows, events, block) {
  if (!events) return rows;
  const cum = cumulativeClaimed(events, block);
  return rows.map((r) => ({ ...r, claimed: cum.get(r.wallet) || 0n }));
}

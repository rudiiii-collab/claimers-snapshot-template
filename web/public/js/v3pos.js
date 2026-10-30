// Concentrated-liquidity position discovery + LP exposure for Aero MetaDEX03.
// The pool exposes gauge(), the gauge exposes nft(), staked token IDs come
// from gauge.stakedValues(wallet), and positions() uses Slipstream ordering.

import {
  sel, encAddress, encUint, returnAddress, returnUint, dataWords, hexToBig,
  decodeUintArray, signedTick, hasAddr, lower,
} from './abi.js';
import { multiCall, resultUint } from './multicall.js';
import { positionAmounts } from './v3math.js';

/**
 * Probe a pool as CL: read slot0/tickSpacing/tokens and resolve gauge + NFPM.
 * Returns null if slot0 reverts (i.e. it's a v2 pool) or price is 0 (empty).
 */
export async function loadCLPool(client, cfg, poolAddr, block) {
  let slot0;
  try {
    slot0 = await client.ethCall(poolAddr, sel.slot0, block);
  } catch {
    return null; // not a CL pool
  }
  const sqrtPriceX96 = returnUint(slot0);
  if (sqrtPriceX96 === 0n) return null;

  const t0 = await client.ethCall(poolAddr, sel.token0, block);
  const t1 = await client.ethCall(poolAddr, sel.token1, block);
  const ts = await client.ethCall(poolAddr, sel.tickSpacing, block);

  const pool = {
    address: lower(poolAddr),
    token0: returnAddress(t0),
    token1: returnAddress(t1),
    tickSpacing: Number(returnUint(ts)),
    sqrtPriceX96,
    gauge: '',
    nfpm: '',
  };
  pool.tokenIsToken0 = pool.token0 === lower(cfg.token);

  // MetaDEX03 pools expose their gauge directly.
  try {
    pool.gauge = returnAddress(await client.ethCall(poolAddr, sel.gauge, block));
  } catch { /* missing/reverting gauge: leave empty */ }
  if (hasAddr(pool.gauge)) {
    try {
      pool.nfpm = returnAddress(await client.ethCall(pool.gauge, sel.nft, block));
    } catch { /* non-CL gauge */ }
  }
  return pool;
}

/**
 * Each claimer's token amount held inside the given CL pools at `block`:
 * wallet -> BigInt (base units). Staged Multicall3 batches (never one call
 * per wallet):
 *   Pass A: NFPM.balanceOf + gauge.stakedValues for every (wallet, pool)
 *   Pass B: tokenOfOwnerByIndex for wallets holding unstaked NFTs
 *   Pass C: positions(tokenId) for every discovered tokenId
 */
export async function snapshotCLLP(client, cfg, claimers, pools, block) {
  const out = new Map();
  if (!pools.length) return out;
  const batch = cfg.multicallBatch;

  // ---- Pass A: balanceOf (unstaked count) + stakedValues (staked ids) ----
  const aCalls = [];
  const aMeta = []; // {wallet, pool: index, kind: 'staked'|'unstaked'}
  for (const cl of claimers) {
    for (let pi = 0; pi < pools.length; pi++) {
      const p = pools[pi];
      // The Dune dataset counts only gauge-staked CL liquidity. Unstaked NFT
      // positions are included only when lpStakedOnly is disabled.
      if (!cfg.lpStakedOnly && p.nfpm) {
        aCalls.push({ target: p.nfpm, data: sel.balanceOf + encAddress(cl.wallet) });
        aMeta.push({ wallet: cl.wallet, pool: pi, kind: 'unstaked' });
      }
      if (hasAddr(p.gauge)) {
        aCalls.push({ target: p.gauge, data: sel.stakedValues + encAddress(cl.wallet) });
        aMeta.push({ wallet: cl.wallet, pool: pi, kind: 'staked' });
      }
    }
  }
  const aRes = await multiCall(client, aCalls, block, batch);

  const mKey = (m) => `${m.wallet}|${m.pool}`;
  const staked = new Map();        // key -> BigInt[] tokenIds
  const unstakedCount = new Map(); // key -> {meta, n}
  for (let i = 0; i < aMeta.length; i++) {
    const r = aRes[i];
    if (!r.success) continue;
    const m = aMeta[i];
    if (m.kind === 'staked') {
      const k = mKey(m);
      const arr = staked.get(k) || [];
      arr.push(...decodeUintArray(r.ret));
      if (arr.length) staked.set(k, arr);
    } else {
      const n = Number(resultUint(r));
      if (n > 0) unstakedCount.set(mKey(m), { meta: m, n });
    }
  }

  // ---- Pass B: tokenOfOwnerByIndex for wallets with unstaked NFTs ----
  const bCalls = [];
  const bMeta = [];
  for (const { meta, n } of unstakedCount.values()) {
    for (let i = 0; i < n; i++) {
      bCalls.push({
        target: pools[meta.pool].nfpm,
        data: sel.tokenOfOwnerByIndex + encAddress(meta.wallet) + encUint(i),
      });
      bMeta.push(meta);
    }
  }
  const unstaked = new Map(); // key -> BigInt[] tokenIds
  if (bCalls.length) {
    const bRes = await multiCall(client, bCalls, block, batch);
    for (let i = 0; i < bMeta.length; i++) {
      if (!bRes[i].success) continue;
      const k = mKey(bMeta[i]);
      const arr = unstaked.get(k) || [];
      arr.push(resultUint(bRes[i]));
      unstaked.set(k, arr);
    }
  }

  // ---- Pass C: positions(tokenId) for all unique tokenIds (per pool) ----
  const posCallIdx = new Map(); // `${pool}|${id}` -> index into cCalls
  const cCalls = [];
  const cKeys = [];
  const addPos = (pi, id) => {
    const k = `${pi}|${id}`;
    if (posCallIdx.has(k)) return;
    posCallIdx.set(k, cCalls.length);
    cCalls.push({ target: pools[pi].nfpm, data: sel.positions + encUint(id) });
    cKeys.push(k);
  };
  const eachIds = (map) => {
    for (const [k, ids] of map) {
      const pi = Number(k.split('|')[1]);
      for (const id of ids) addPos(pi, id);
    }
  };
  eachIds(staked);
  eachIds(unstaked);

  const posByKey = new Map();
  if (cCalls.length) {
    const cRes = await multiCall(client, cCalls, block, batch);
    for (let i = 0; i < cKeys.length; i++) {
      if (!cRes[i].success) continue;
      const w = dataWords(cRes[i].ret);
      if (w.length < 8) continue;
      // Slipstream layout: nonce, operator, token0, token1, tickSpacing,
      // tickLower, tickUpper, liquidity, ...
      posByKey.set(cKeys[i], {
        token0: '0x' + w[2].slice(24).toLowerCase(),
        token1: '0x' + w[3].slice(24).toLowerCase(),
        tickLower: signedTick(w[5]),
        tickUpper: signedTick(w[6]),
        liquidity: hexToBig('0x' + w[7]),
      });
    }
  }

  // ---- Sum the tracked-token side per wallet ----
  const add = (wallet, amt) => {
    if (amt === 0n) return;
    out.set(wallet, (out.get(wallet) || 0n) + amt);
  };
  const tokenAmount = (pool, pos) => {
    if (pos.token0 !== pool.token0 || pos.token1 !== pool.token1) return 0n; // not this pool
    const [a0, a1] = positionAmounts(pool.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity);
    return pool.tokenIsToken0 ? a0 : a1;
  };
  const sumIds = (map) => {
    for (const [k, ids] of map) {
      const [wallet, piStr] = k.split('|');
      const pi = Number(piStr);
      for (const id of ids) {
        const pos = posByKey.get(`${pi}|${id}`);
        if (pos) add(wallet, tokenAmount(pools[pi], pos));
      }
    }
  };
  sumIds(staked);
  sumIds(unstaked);
  return out;
}

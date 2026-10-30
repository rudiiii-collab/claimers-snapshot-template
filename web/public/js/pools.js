// Pool resolution + discovery — port of pools.go. Manual POOLS is the primary
// path (recommended by ADAPTING.md); PoolCreated discovery is the self-serve
// helper for "paste a token, find its pools".

import {
  sel, encAddress, addressTopic, topicToAddress, returnAddress, returnUint,
  dataWords, decodeString, lower, signedTick,
} from './abi.js';
import { isRangeError, parseSuggestedRange } from './rpc.js';

/** Resolve token0/token1 (and the tracked token's side) for manual pools. */
export async function resolveManualPools(client, cfg, block) {
  const pools = [];
  for (const addr of cfg.pools) {
    const t0 = returnAddress(await client.ethCall(addr, sel.token0, block));
    const t1 = returnAddress(await client.ethCall(addr, sel.token1, block));
    pools.push({
      address: lower(addr),
      token0: t0,
      token1: t1,
      tokenIsToken0: t0 === lower(cfg.token),
    });
  }
  return pools;
}

/**
 * Self-serve Aero CL discovery: scan
 * PoolCreated(token0, token1, tickSpacing, pool) on CLFactory for pools
 * containing `token` (as token0 OR token1). Returns
 * [{address, token0, token1, tickSpacing}].
 */
export async function discoverPools(client, cfg, start, end, topicPoolCreated, onProgress) {
  const tokenTopic = addressTopic(cfg.token);
  const seen = new Set();
  const pools = [];
  let chunk = cfg.chunkBlocks > 0n ? cfg.chunkBlocks : 50000n;

  // Two passes: token at indexed token0 position, then token1 position.
  const filters = [
    [topicPoolCreated, tokenTopic],
    [topicPoolCreated, null, tokenTopic],
  ];
  for (const topics of filters) {
    for (let from = start; from <= end;) {
      let to = from + chunk - 1n;
      if (to > end) to = end;
      let logs;
      try {
        logs = await client.getLogs(cfg.factory, from, to, topics);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (isRangeError(err) && to > from) {
          let nc = BigInt(parseSuggestedRange(err.message) || 0);
          if (nc === 0n || nc >= chunk) nc = chunk / 2n;
          if (nc < 1n) nc = 1n;
          chunk = nc;
          continue;
        }
        throw new Error(`PoolCreated getLogs [${from},${to}]: ${err.message}`);
      }
      from = to + 1n;
      onProgress?.(`scanning PoolCreated to block ${to}…`);
      for (const lg of logs) {
        if (!lg.topics || lg.topics.length < 4) continue;
        const words = dataWords(lg.data);
        if (words.length < 1) continue;
        const pool = '0x' + words[0].slice(24).toLowerCase();
        if (seen.has(pool)) continue;
        seen.add(pool);
        pools.push({
          address: pool,
          token0: lower(topicToAddress(lg.topics[1])),
          token1: lower(topicToAddress(lg.topics[2])),
          tickSpacing: signedTick(lg.topics[3].slice(2)),
        });
      }
    }
  }
  return pools;
}

/** Token helper: fetch decimals() + symbol() for form auto-fill. */
export async function tokenInfo(client, token, block) {
  const dec = Number(returnUint(await client.ethCall(token, sel.decimals, block)));
  let symbol = '';
  try {
    symbol = decodeString(await client.ethCall(token, sel.symbol, block));
  } catch { /* non-standard token */ }
  return { decimals: dec, symbol };
}

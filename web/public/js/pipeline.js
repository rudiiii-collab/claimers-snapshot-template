// Job runner: config -> snapshot series, mirroring the Go CLI's
// `snapshots` command end to end:
//   1. scan (or load cached) ClaimRewards events        [logs RPC, wide ranges]
//   2. build the claimer set (CSV import or from events)
//   3. resolve pools (v2 vs CL auto-detected per block)
//   4. per snapshot block: checkpoint-or-compute hold/LP [archive RPC]
//      + cumulative claimed re-derived from events (zero RPC on cache hits)
//
// Two RPC endpoints, like the repo's provider note: the archive RPC serves
// historical eth_call; the logs RPC serves wide-range eth_getLogs.

import { Client } from './rpc.js';
import { topic0 } from './keccak.js';
import { CLAIM_REWARDS_SIG } from './abi.js';
import { scanClaimEvents, claimersFromEvents, importClaimers } from './claims.js';
import { resolveManualPools } from './pools.js';
import { computeSnapshot, totalsFromRows, applyCumulativeClaimed } from './snapshot.js';
import * as store from './store.js';

/**
 * @param cfg normalized config (see main.js buildConfig)
 * @param onProgress ({phase, done, total, note}) => void
 * @param signal AbortSignal for cancel
 * @returns {series, snapshots, claimers, stats}
 */
export async function runPipeline(cfg, onProgress, signal) {
  const logsClient = new Client(cfg.logsRpc || cfg.archiveRpc, cfg.ratePerSecond, cfg.maxRetries, signal);
  const archiveClient = new Client(cfg.archiveRpc || cfg.logsRpc, cfg.ratePerSecond, cfg.maxRetries, signal);
  if (!logsClient.url) throw new Error('Set at least one RPC endpoint.');

  const claimTopic = topic0(cfg.claimEventSig || CLAIM_REWARDS_SIG);
  const cfgWithTopic = { ...cfg, claimTopic0: claimTopic };

  // ---- 1. Claim events (needed for cumulative claimed and/or scan source) ----
  let events = null;
  const needEvents = cfg.cumulative || cfg.claimerSource === 'scan';
  if (needEvents) {
    onProgress({ phase: 'events', note: 'claim-event scan…' });
    const evKey = 'ev:' + await store.hashKey({
      bribe: cfg.votingReward, reward: cfg.token,
      start: cfg.startBlock, end: cfg.endBlock, sig: claimTopic,
    });
    events = cfg.force ? null : await store.loadClaimEventsCache(evKey);
    if (events) {
      onProgress({ phase: 'events', note: `using ${events.length} cached claim events` });
    } else {
      events = await scanClaimEvents(logsClient, cfgWithTopic, cfg.startBlock, cfg.endBlock,
        (p) => onProgress({ phase: 'events', ...p }));
      await store.saveClaimEventsCache(evKey, events);
      onProgress({ phase: 'events', note: `scanned ${events.length} claim events (cached)` });
    }
  }

  // ---- 2. Claimer set ----
  let claimers;
  if (cfg.claimerSource === 'csv') {
    claimers = importClaimers(cfg.claimersCSVText, cfg);
    onProgress({ phase: 'claimers', note: `imported ${claimers.length} claimers > ${cfg.minClaimed} from CSV` });
  } else {
    claimers = claimersFromEvents(events, cfg);
    onProgress({ phase: 'claimers', note: `found ${claimers.length} wallets with claimed > ${cfg.minClaimed}` });
  }
  if (!claimers.length) throw new Error('No claimers above MIN_CLAIMED — nothing to snapshot.');

  // ---- 3. Pools (manual list; ordering + type auto-detected) ----
  const pools = await resolveManualPools(archiveClient, cfg, cfg.endBlock);
  onProgress({
    phase: 'pools',
    note: pools.map((p) => `${p.address} (${cfg.symbol || 'token'} is token${p.tokenIsToken0 ? '0' : '1'})`).join(', ') || 'no pools',
  });

  // ---- 4. Snapshots ----
  // Checkpoints hold the expensive hold/LP reads. Scope them by everything
  // that changes those reads — a changed claimer set or pool list invalidates
  // automatically (the Go tool needs --force for this).
  const scopeKey = 'cp:' + await store.hashKey({
    token: cfg.token, pools: cfg.pools, staked: cfg.lpStakedOnly,
    wallets: claimers.map((c) => c.wallet).sort(),
  });

  const blocks = [];
  for (let b = cfg.startBlock; b <= cfg.endBlock; b += cfg.stepBlocks) blocks.push(b);

  const cumEvents = cfg.cumulative ? events : null;
  const series = [];
  const snapshots = [];
  let fromCache = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    onProgress({ phase: 'snapshots', done: i, total: blocks.length, note: `block ${block}…` });

    let rows, timestamp;
    const cp = cfg.force ? null : await store.loadCheckpoint(scopeKey, block.toString());
    if (cp) {
      // Reuse cached hold/LP; recompute claimed from events (zero RPC).
      rows = applyCumulativeClaimed(cp.rows, cumEvents, block);
      if (!cumEvents) {
        // Fixed-total mode: stamp the lifetime totals from the claimer set.
        const totals = new Map(claimers.map((c) => [c.wallet, c.raw]));
        rows = cp.rows.map((r) => ({ ...r, claimed: totals.get(r.wallet) || 0n }));
      }
      timestamp = cp.timestamp;
      fromCache++;
    } else {
      rows = await computeSnapshot(archiveClient, cfgWithTopic, claimers, pools, block, cumEvents,
        (p) => onProgress({ phase: 'snapshots', done: i, total: blocks.length, ...p }));
      timestamp = await archiveClient.blockTimestamp(block);
      await store.saveCheckpoint(scopeKey, block.toString(), timestamp, rows);
    }
    snapshots.push({ block, timestamp, rows });
    series.push(totalsFromRows(block, timestamp, rows));
  }

  onProgress({
    phase: 'done', done: blocks.length, total: blocks.length,
    note: `${blocks.length} snapshots (${fromCache} from cache) — ` +
      `${archiveClient.stats.requests + logsClient.stats.requests} RPC requests`,
  });
  return { series, snapshots, claimers, pools };
}

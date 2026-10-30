// Job runner: Aero MetaDEX03 config -> incentive-only snapshot series:
//   1. discover matching incentive programs and scan ClaimIncentives
//   2. build the claimer set (CSV import or from events)
//   3. resolve configured Aero CL pools
//   4. per snapshot block: checkpoint-or-compute hold/LP [archive RPC]
//      + cumulative claimed re-derived from events (zero RPC on cache hits)
//
// Two RPC endpoints, like the repo's provider note: the archive RPC serves
// historical eth_call; the logs RPC serves wide-range eth_getLogs.

import { Client } from './rpc.js';
import { scanClaimEvents, claimersFromEvents, importClaimers } from './claims.js';
import { resolveManualPools } from './pools.js';
import { computeSnapshot, totalsFromRows, applyCumulativeClaimed } from './snapshot.js';
import * as store from './store.js';

/** Inputs that make Hold/LP checkpoints reusable. Keep versioned so algorithm
 * migrations never reuse legacy IndexedDB rows. `chainId` is read from RPC,
 * while the UI label and endpoint identity add useful migration isolation. */
export function checkpointScopeDescriptor(cfg, claimers, chainId) {
  return {
    version: 'aero-metadex03-v1',
    chainId: String(chainId),
    chain: cfg.chain || 'custom',
    archiveRpc: cfg.archiveRpc || cfg.logsRpc || '',
    token: cfg.token,
    pools: cfg.pools,
    staked: cfg.lpStakedOnly,
    wallets: claimers.map((c) => c.wallet).sort(),
  };
}

/** Inputs that make the discovered incentive event set reusable. */
export function eventCacheDescriptor(cfg, chainId) {
  return {
    version: 'aero-incentives-v1',
    chainId: String(chainId),
    chain: cfg.chain || 'custom',
    logsRpc: cfg.logsRpc || cfg.archiveRpc || '',
    manager: cfg.votingReward,
    reward: cfg.token,
    programStart: cfg.programScanStart,
    start: cfg.startBlock,
    end: cfg.endBlock,
  };
}

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

  const logsChainId = await logsClient.chainId();
  const archiveChainId = archiveClient.url === logsClient.url
    ? logsChainId : await archiveClient.chainId();
  if (archiveChainId !== logsChainId) {
    throw new Error(`RPC chain mismatch: logs RPC is chain ${logsChainId}, archive RPC is chain ${archiveChainId}.`);
  }
  const chainId = logsChainId;

  // ---- 1. Incentive claim events (cumulative and/or scan source) ----
  let events = null;
  const needEvents = cfg.cumulative || cfg.claimerSource === 'scan';
  if (needEvents) {
    onProgress({ phase: 'events', note: 'incentive-program discovery + ClaimIncentives scan…' });
    const evKey = 'ev:aero-incentives-v1:' + await store.hashKey(
      eventCacheDescriptor(cfg, chainId));
    events = cfg.force ? null : await store.loadClaimEventsCache(evKey);
    if (events) {
      onProgress({ phase: 'events', note: `using ${events.length} cached claim events` });
    } else {
      events = await scanClaimEvents(logsClient, cfg, cfg.startBlock, cfg.endBlock,
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
  // Checkpoints hold the expensive hold/LP reads. Scope them by every input
  // that changes those reads, plus a migration version and chain/RPC identity.
  const scopeKey = 'cp:aero-metadex03-v1:' + await store.hashKey(
    checkpointScopeDescriptor(cfg, claimers, chainId));

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
      rows = await computeSnapshot(archiveClient, cfg, claimers, pools, block, cumEvents,
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

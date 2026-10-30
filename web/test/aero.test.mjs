// Offline Aero tests. Fixture hex is preserved verbatim from the supplied spec.
import assert from 'node:assert/strict';
import { scanClaimEvents, cumulativeClaimed } from '../public/js/claims.js';
import { discoverPools } from '../public/js/pools.js';
import { loadCLPool } from '../public/js/v3pos.js';
import {
  addressTopic, encUint, topicClaimFees, topicClaimIncentives,
  topicIncentiveCreated, topicPoolCreated, sel,
} from '../public/js/abi.js';

export const RSGP = '0x44b63af715d5ef02cc3646a6ce96875e11d69e85';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const MANAGER = '0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f';
export const WALLET = '0x63b4f15788aaa877a9466d2a5c1400325379931a';
export const programTopic = (id) => '0x' + encUint(id);
export const feeLog = {
  address: MANAGER, blockNumber: '0x' + (53250275n).toString(16), logIndex: '0x1bf',
  topics: [topicClaimFees, programTopic(4235), addressTopic(WALLET), addressTopic(RSGP)],
  data: '0x000000000000000000000000000000000000000000000000005894ba52570e25',
};
export const incentiveLog = {
  ...feeLog, logIndex: '0x1c7',
  topics: [topicClaimIncentives, programTopic(4235), addressTopic(WALLET), programTopic(1)],
  data: '0x00000000000000000000000000000000000000000000000000065e00fcb55761',
};
export const creation = (id, token, block) => ({
  address: MANAGER, blockNumber: '0x' + BigInt(block).toString(16),
  topics: [topicIncentiveCreated, programTopic(id), addressTopic(token), addressTopic(WALLET)],
  data: '0x' + encUint(0) + encUint(0) + encUint(0),
});
export const cfg = { token: RSGP, votingReward: MANAGER, decimals: 18, symbol: 'RSGP',
  programScanStart: 53171524n, startBlock: 53250275n, endBlock: 53275371n, chunkBlocks: 200000n };

export async function runAeroTests() {
  const calls = [], progress = [];
  const client = { async getLogs(address, from, to, topics) {
    calls.push({ from, to, topics });
    assert.equal(address, MANAGER);
    if (topics[0] === topicIncentiveCreated) {
      assert.deepEqual(topics, [topicIncentiveCreated, null, addressTopic(RSGP)]);
      assert.equal(from, cfg.programScanStart, 'discover programs before claim window');
      return [creation(1, RSGP, 53173281), creation(17, RSGP, 53261472),
        creation(18, RSGP, 53275371), creation(2, USDC, 53191778)];
    }
    assert.deepEqual(topics, [topicClaimIncentives, null, null, [1, 17, 18].map(programTopic)]);
    assert.equal(from, cfg.startBlock);
    assert.equal(to, cfg.endBlock);
    // Deliberately return unrelated logs too: decoder must defend against them.
    return [incentiveLog, feeLog, { ...feeLog, topics: [...feeLog.topics.slice(0, 3), addressTopic(USDC)] },
      ...[2, 3, 5, 6, 10].map((id) => ({ ...incentiveLog, topics: [...incentiveLog.topics.slice(0, 3), programTopic(id)] }))];
  } };
  const events = await scanClaimEvents(client, cfg, cfg.startBlock, cfg.endBlock, (p) => progress.push(p));
  assert.deepEqual(events, [{ wallet: WALLET, block: 53250275n, amount: 1792208193017697n }]);
  assert.equal(cumulativeClaimed(events, 53250274n).get(WALLET), undefined);
  assert.equal(cumulativeClaimed(events, 53250275n).get(WALLET), 1792208193017697n);
  assert.equal(calls.length, 2, 'creation and incentives only; never scan fees');
  assert.ok(progress.some((p) => p.audit && p.note.includes('1 -> ' + RSGP)));
  assert.ok(progress.some((p) => p.audit && p.note.includes('program 18') && p.note.includes('0 events')));
  assert.ok(progress.some((p) => p.audit && p.note.includes('0.001792208193017697')));
  console.log('PASS Aero incentive-only real fixture, filters, program mapping and unfiltered totals');

  const noProgramsCalls = [];
  const none = await scanClaimEvents({ async getLogs(address, from, to, topics) {
    noProgramsCalls.push(topics);
    assert.equal(from, cfg.startBlock, 'programScanStart defaults to startBlock');
    assert.equal(topics[0], topicIncentiveCreated);
    return [creation(2, USDC, cfg.startBlock)];
  } }, { ...cfg, programScanStart: undefined }, cfg.startBlock, cfg.endBlock);
  assert.deepEqual(none, []);
  assert.equal(noProgramsCalls.length, 1, 'zero programs means no fees and no incentive request');
  console.log('PASS no matching programs returns zero claims, no ClaimIncentives request');

  const retryCalls = [];
  let rejected = false;
  const retryClient = { async getLogs(address, from, to, topics) {
    retryCalls.push({ from, to, topics });
    if (!rejected) { rejected = true; throw new Error('eth_getLogs is limited to a 10,000 range'); }
    const logs = topics[0] === topicIncentiveCreated ? [creation(1, RSGP, 53173281)] : [incentiveLog];
    return logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
  } };
  const retried = await scanClaimEvents(retryClient, cfg, cfg.startBlock, cfg.endBlock);
  assert.deepEqual(retried, events);
  assert.equal(retryCalls[0].from, retryCalls[1].from, 'retry same start, no skipped blocks');
  assert.ok(retryCalls[1].to < retryCalls[0].to, 'range shrunk');
  console.log('PASS provider 10,000-range rejection shrinks and preserves claim');

  let attempts = 0;
  await assert.rejects(scanClaimEvents({ async getLogs() {
    attempts++;
    if (attempts > 2) throw new Error('test safety stop');
    throw new Error('limited to a 10,000 range');
  } }, { ...cfg, chunkBlocks: 1n }, cfg.startBlock, cfg.endBlock));
  assert.equal(attempts, 1, 'single-block rejection fails instead of looping forever');
  const cancelled = new DOMException('cancelled', 'AbortError');
  await assert.rejects(scanClaimEvents({ async getLogs() { throw cancelled; } }, cfg,
    cfg.startBlock, cfg.endBlock), (e) => e === cancelled);
  await assert.rejects(scanClaimEvents({ async getLogs() { throw new Error('must not call'); } },
    { ...cfg, programScanStart: cfg.startBlock + 1n }, cfg.startBlock, cfg.endBlock), /Program scan start/);
  console.log('PASS scan validation, bounded retry and cancellation');

  const POOL = '0x8e859b6cf564c4ac2b848693c85c496e81dbf6c8';
  const GAUGE = '0x77e3e1b150d4509aade60b73c48f77cab00272b1';
  const NFPM = '0x4857db576ee0e45f10525ec59527bfd10beec60b';
  const addressWord = (address) => '0x' + address.slice(2).padStart(64, '0');
  const signedWord = (value) => '0x' + (value < 0 ? (1n << 256n) + BigInt(value) : BigInt(value))
    .toString(16).padStart(64, '0');
  const poolCreatedLog = {
    topics: [topicPoolCreated, addressTopic(RSGP), addressTopic(USDC), signedWord(-100)],
    data: addressWord(POOL),
  };
  const discoveryCalls = [];
  const pools = await discoverPools({ async getLogs(address, from, to, topics) {
    discoveryCalls.push({ address, from, to, topics });
    return topics[1] === addressTopic(RSGP) ? [poolCreatedLog] : [];
  } }, { token: RSGP, factory: '0x9cb220581b91b0c83223012fe69688b92ad07a76', chunkBlocks: 1000n },
  53171000n, 53171999n, topicPoolCreated);
  assert.deepEqual(pools, [{ address: POOL, token0: RSGP, token1: USDC, tickSpacing: -100 }]);
  assert.equal(discoveryCalls.length, 2, 'token0 and token1 discovery passes');
  console.log('PASS Aero CLFactory PoolCreated decoding uses signed tickSpacing');

  let discoveryAttempts = 0;
  await assert.rejects(discoverPools({ async getLogs() {
    discoveryAttempts++;
    if (discoveryAttempts > 1) throw new Error('test safety stop');
    throw new Error('eth_getLogs is limited to a 10,000 range');
  } }, { token: RSGP, factory: MANAGER, chunkBlocks: 1n },
  cfg.startBlock, cfg.startBlock, topicPoolCreated), /limited to a 10,000 range/);
  assert.equal(discoveryAttempts, 1, 'single-block pool discovery rejection must not loop');
  console.log('PASS pool discovery single-block range rejection is bounded');

  const { checkpointScopeDescriptor, eventCacheDescriptor } = await import('../public/js/pipeline.js');
  const scope = checkpointScopeDescriptor({
    chain: 'base', archiveRpc: 'https://mainnet.base.org', token: RSGP,
    pools: [POOL], lpStakedOnly: true,
  }, [{ wallet: WALLET }], 8453n);
  assert.equal(scope.version, 'aero-metadex03-v1');
  assert.equal(scope.chainId, '8453');
  assert.equal(scope.chain, 'base');
  assert.equal(scope.archiveRpc, 'https://mainnet.base.org');
  assert.deepEqual(scope.wallets, [WALLET]);
  assert.notDeepEqual(scope, checkpointScopeDescriptor({
    chain: 'base', archiveRpc: 'https://mainnet.base.org', token: RSGP,
    pools: [POOL], lpStakedOnly: true,
  }, [{ wallet: WALLET }], 1n), 'checkpoint scope changes with authoritative chain id');
  const eventCfg = { ...cfg, chain: 'base', logsRpc: 'https://base-rpc.publicnode.com' };
  assert.notDeepEqual(eventCacheDescriptor(eventCfg, 8453n), eventCacheDescriptor(eventCfg, 1n),
    'event cache changes with authoritative chain id');
  assert.notDeepEqual(eventCacheDescriptor(eventCfg, 8453n),
    eventCacheDescriptor({ ...eventCfg, logsRpc: 'https://other-rpc.example' }, 8453n),
    'event cache changes with logs RPC identity');
  console.log('PASS event/checkpoint caches are versioned and authoritative-chain scoped');

  const callsByTarget = [];
  const cl = await loadCLPool({ async ethCall(target, data) {
    callsByTarget.push({ target, data });
    if (target === POOL && data === sel.slot0) return '0x' + encUint(1n << 96n) + encUint(0);
    if (target === POOL && data === sel.token0) return addressWord(RSGP);
    if (target === POOL && data === sel.token1) return addressWord(USDC);
    if (target === POOL && data === sel.tickSpacing) return signedWord(100);
    if (target === POOL && data === sel.gauge) return addressWord(GAUGE);
    if (target === GAUGE && data === sel.nft) return addressWord(NFPM);
    throw new Error(`unexpected eth_call ${target} ${data}`);
  } }, { token: RSGP }, POOL, cfg.endBlock);
  assert.equal(cl.gauge, GAUGE);
  assert.equal(cl.nfpm, NFPM);
  assert.ok(callsByTarget.some((c) => c.target === POOL && c.data === sel.gauge), 'pool.gauge() used');
  assert.equal(callsByTarget.some((c) => c.data.startsWith(sel.gauge) && c.data !== sel.gauge), false,
    'legacy voter.gauges(pool) call absent');
  console.log('PASS Aero CL pool resolves gauge() directly and gauge.nft()');
}

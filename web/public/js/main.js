// UI wiring: form <-> config, job runner, results rendering.

import { Client } from './rpc.js';
import { runPipeline } from './pipeline.js';
import { tokenInfo, discoverPools } from './pools.js';
import { topicPoolCreated, lower } from './abi.js';
import { renderChart, legendHTML } from './chart.js';
import { formatUnits, buildDuneCSV, buildTimeseriesCSV, downloadCSV } from './csv.js';
import * as store from './store.js';

// Chain presets. "Custom" clears the chain-specific fields.
const PRESETS = {
  base: {
    // Split defaults: PublicNode handles historical wide-range getLogs;
    // mainnet.base.org serves historical eth_call but currently rate-limits
    // getLogs aggressively. Users can replace either endpoint.
    logsRpc: 'https://base-rpc.publicnode.com',
    archiveRpc: 'https://mainnet.base.org',
    archivePlaceholder: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY',
    factory: '0x9cb220581b91b0c83223012fe69688b92ad07a76', // Aero CLFactory
    // RSGP incentive-only example on Aero MetaDEX03:
    example: {
      token: '0x44b63af715d5ef02cc3646a6ce96875e11d69e85',
      symbol: 'RSGP',
      decimals: 18,
      votingReward: '0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f',
      pools: '0x8e859b6cf564c4ac2b848693c85c496e81dbf6c8',
      startBlock: '53171524',
      programScanStart: '53171524',
      endBlock: '53275371',
      stepBlocks: '3600',
      minClaimed: '1000',
    },
  },
};

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'chain', 'archiveRpc', 'logsRpc', 'token', 'decimals', 'symbol', 'votingReward',
  'pools', 'startBlock', 'endBlock', 'stepBlocks', 'minClaimed', 'factory',
  'programScanStart', 'chunkBlocks', 'multicallBatch', 'ratePerSecond',
];
const CHECKS = ['lpStakedOnly', 'cumulative', 'force'];

let claimersCSVText = null;
let lastResult = null;
let lastConfig = null;
let abortController = null;

// ---- form persistence -------------------------------------------------------

function readForm() {
  const v = {};
  for (const f of FIELDS) v[f] = $(f).value.trim();
  for (const c of CHECKS) v[c] = $(c).checked;
  v.claimerSource = document.querySelector('input[name=claimerSource]:checked').value;
  return v;
}

function fillForm(v) {
  for (const f of FIELDS) if (v[f] !== undefined) $(f).value = v[f];
  for (const c of CHECKS) if (v[c] !== undefined) $(c).checked = v[c];
  if (v.claimerSource) {
    const r = document.querySelector(`input[name=claimerSource][value=${v.claimerSource}]`);
    if (r) r.checked = true;
  }
}

function applyPreset(name, withExample) {
  const p = PRESETS[name];
  if (!p) return;
  $('logsRpc').value = $('logsRpc').value || p.logsRpc;
  $('archiveRpc').value = $('archiveRpc').value || p.archiveRpc || '';
  $('archiveRpc').placeholder = p.archivePlaceholder;
  $('factory').value = $('factory').value || p.factory;
  if (withExample) {
    for (const [k, val] of Object.entries(p.example)) $(k).value = val;
  }
}

// ---- config normalization ---------------------------------------------------

function requireAddr(id, label) {
  const v = lower($(id).value.trim());
  const ok = /^0x[0-9a-f]{40}$/.test(v);
  $(id).setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) throw new Error(`${label} must be a 0x… address`);
  return v;
}

function requireBig(id, label) {
  const v = $(id).value.trim().replace(/[,_ ]/g, '');
  const ok = /^\d+$/.test(v);
  $(id).setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) throw new Error(`${label} must be a whole number`);
  return BigInt(v);
}

function buildConfig() {
  const cfg = {
    chain: $('chain').value,
    archiveRpc: $('archiveRpc').value.trim(),
    logsRpc: $('logsRpc').value.trim(),
    token: requireAddr('token', 'Token contract'),
    decimals: parseInt($('decimals').value, 10) || 18,
    symbol: $('symbol').value.trim(),
    votingReward: requireAddr('votingReward', 'VotingRewardsManager'),
    pools: $('pools').value.split(',').map((s) => lower(s.trim())).filter(Boolean),
    startBlock: requireBig('startBlock', 'Start block'),
    endBlock: requireBig('endBlock', 'End block'),
    stepBlocks: requireBig('stepBlocks', 'Step'),
    minClaimed: $('minClaimed').value.trim() || '0',
    claimerSource: document.querySelector('input[name=claimerSource]:checked').value,
    claimersCSVText,
    factory: lower($('factory').value.trim()),
    chunkBlocks: BigInt($('chunkBlocks').value.trim() || '50000'),
    multicallBatch: parseInt($('multicallBatch').value, 10) || 500,
    ratePerSecond: parseFloat($('ratePerSecond').value) || 8,
    maxRetries: 6,
    lpStakedOnly: $('lpStakedOnly').checked,
    cumulative: $('cumulative').checked,
    force: $('force').checked,
  };
  cfg.programScanStart = $('programScanStart').value.trim()
    ? requireBig('programScanStart', 'Program scan start block') : cfg.startBlock;
  const validProgramStart = cfg.programScanStart <= cfg.startBlock;
  $('programScanStart').setAttribute('aria-invalid', validProgramStart ? 'false' : 'true');
  if (!validProgramStart) throw new Error('Program scan start block must be ≤ start block for complete program discovery.');
  for (const p of cfg.pools) {
    if (!/^0x[0-9a-f]{40}$/.test(p)) throw new Error(`Pool "${p}" is not a 0x… address`);
  }
  if (!cfg.pools.length) throw new Error('Set at least one pool address (or use Discover pools).');
  if (!cfg.archiveRpc && !cfg.logsRpc) throw new Error('Set an RPC endpoint.');
  if (cfg.endBlock < cfg.startBlock) throw new Error('End block must be ≥ start block.');
  if (cfg.stepBlocks <= 0n) throw new Error('Step must be > 0.');
  if (cfg.claimerSource === 'csv' && !claimersCSVText) throw new Error('Choose a claimers CSV file.');
  const n = Number((cfg.endBlock - cfg.startBlock) / cfg.stepBlocks) + 1;
  if (n > 500) throw new Error(`${n} snapshots — that's a lot. Increase the step (or narrow the range).`);
  return cfg;
}

function snapshotCount() {
  try {
    const s = BigInt($('startBlock').value.trim() || '0');
    const e = BigInt($('endBlock').value.trim() || '0');
    const st = BigInt($('stepBlocks').value.trim() || '0');
    if (e >= s && st > 0n) {
      $('step-note').textContent = `≈ ${Number((e - s) / st) + 1} snapshots`;
      return;
    }
  } catch { /* ignore while typing */ }
  $('step-note').textContent = '';
}

// ---- progress / status ------------------------------------------------------

function setProgress(p) {
  const bar = $('bar-fill');
  const line = $('status-line');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : (p.phase === 'done' ? 100 : 0);
  if (p.total || p.phase === 'done') bar.style.width = `${pct}%`;
  const phase = { events: 'Claim scan', claimers: 'Claimers', pools: 'Pools', snapshots: 'Snapshots', done: 'Done' }[p.phase] || '';
  line.textContent = [phase, p.total ? `${p.done}/${p.total}` : '', p.note || ''].filter(Boolean).join(' — ');
}

function setError(msg) { $('error-line').textContent = msg || ''; }

// ---- results rendering ------------------------------------------------------

function renderResults(result, cfg) {
  lastResult = result;
  lastConfig = cfg;
  $('results').classList.remove('hidden');

  $('pool-summary').textContent = result.pools
    .map((p) => `pool ${p.address}: ${cfg.symbol || 'token'} is token${p.tokenIsToken0 ? '0' : '1'}`)
    .join(' · ') + ` · ${result.claimers.length} claimers > ${cfg.minClaimed} ${cfg.symbol || ''}`;

  $('legend').innerHTML = legendHTML(cfg.symbol);
  renderChart($('chart'), result.series, cfg.decimals);

  // Block selector for the per-wallet table (default: last block).
  const sel = $('block-select');
  sel.innerHTML = '';
  result.snapshots.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${s.block}${s.timestamp ? ' — ' + new Date(s.timestamp * 1000).toLocaleString() : ''}`;
    sel.appendChild(o);
  });
  sel.value = String(result.snapshots.length - 1);
  renderWalletTable();
}

function renderWalletTable() {
  if (!lastResult) return;
  const snap = lastResult.snapshots[Number($('block-select').value)];
  if (!snap) return;
  const d = lastConfig.decimals;
  const fmt = (v) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const rows = [...snap.rows].sort((a, b) => (a.claimed < b.claimed ? 1 : -1));
  const tbody = $('wallet-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const outflow = r.claimed - r.hold - r.lp;
    tr.innerHTML =
      `<td>${r.wallet}</td><td>${fmt(r.claimed)}</td><td>${fmt(r.hold)}</td>` +
      `<td>${fmt(r.lp)}</td><td>${fmt(outflow)}</td>`;
    tbody.appendChild(tr);
  }
}

// ---- run / cancel -----------------------------------------------------------

async function run(ev) {
  ev.preventDefault();
  setError('');
  let cfg;
  try {
    cfg = buildConfig();
  } catch (e) {
    setError(e.message);
    return;
  }
  store.saveFormConfig(readForm());

  abortController = new AbortController();
  $('btn-run').disabled = true;
  $('btn-cancel').disabled = false;
  $('progress').classList.add('active');
  $('bar-fill').style.width = '0%';

  try {
    const result = await runPipeline(cfg, setProgress, abortController.signal);
    renderResults(result, cfg);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    if (e.name === 'AbortError') setProgress({ phase: 'done', note: 'cancelled — completed blocks are cached and will resume' });
    else { console.error(e); setError(e.message); }
  } finally {
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = true;
    abortController = null;
  }
}

// ---- helpers: auto-detect + discovery ----------------------------------------

async function autoTokenInfo() {
  setError('');
  const note = $('token-note');
  try {
    const token = requireAddr('token', 'Token contract');
    const rpc = $('archiveRpc').value.trim() || $('logsRpc').value.trim();
    if (!rpc) throw new Error('Set an RPC endpoint first.');
    note.textContent = 'reading decimals() / symbol()…';
    const client = new Client(rpc, 8, 3);
    const head = await client.blockNumber();
    const info = await tokenInfo(client, token, head);
    $('decimals').value = info.decimals;
    if (info.symbol) $('symbol').value = info.symbol;
    note.className = 'note ok';
    note.textContent = `✓ ${info.symbol || 'token'} — ${info.decimals} decimals`;
  } catch (e) {
    note.className = 'note err';
    note.textContent = e.message;
  }
}

async function discover() {
  setError('');
  const note = $('pools-note');
  try {
    const token = requireAddr('token', 'Token contract');
    const factory = requireAddr('factory', 'Aero CLFactory (advanced)');
    const rpc = $('logsRpc').value.trim() || $('archiveRpc').value.trim();
    if (!rpc) throw new Error('Set a logs RPC first.');
    const start = requireBig('startBlock', 'Start block');
    const client = new Client(rpc, 8, 4);
    const head = await client.blockNumber();
    note.className = 'note';
    note.textContent = 'scanning PoolCreated…';
    // Scan from well before the snapshot window (pool usually predates claims).
    const scanStart = start > 2000000n ? start - 2000000n : 0n;
    const cfg = { token, factory, chunkBlocks: BigInt($('chunkBlocks').value || '50000') };
    const found = await discoverPools(client, cfg, scanStart, head, topicPoolCreated,
      (msg) => { note.textContent = msg; });
    if (!found.length) {
      note.className = 'note err';
      note.textContent = 'No pools found in the scanned range — check the factory, or enter the pool manually.';
      return;
    }
    $('pools').value = found.map((p) => p.address).join(', ');
    note.className = 'note ok';
    note.textContent = `✓ ${found.length} pool(s): ` +
      found.map((p) => `${p.address.slice(0, 10)}… (token${lower(p.token0) === token ? '0' : '1'}; tickSpacing ${p.tickSpacing})`).join(', ');
  } catch (e) {
    note.className = 'note err';
    note.textContent = e.message;
  }
}

// ---- init ---------------------------------------------------------------------

function init() {
  const saved = store.loadFormConfig();
  if (saved) {
    fillForm(saved);
    applyPreset($('chain').value, false);
  } else {
    applyPreset('base', true); // first visit: show the RSGP incentive-only example
  }
  snapshotCount();

  $('config-form').addEventListener('submit', run);
  $('btn-cancel').addEventListener('click', () => abortController?.abort());
  $('btn-token-info').addEventListener('click', autoTokenInfo);
  $('btn-discover').addEventListener('click', discover);
  $('btn-clear-cache').addEventListener('click', async () => {
    await store.clearAllCaches();
    setProgress({ phase: 'done', note: 'local caches cleared' });
    $('progress').classList.add('active');
  });
  $('block-select').addEventListener('change', renderWalletTable);
  $('btn-dl-dune').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCSV(`dune_${(lastConfig.symbol || 'token').toLowerCase()}_claimers.csv`,
      buildDuneCSV(lastResult.snapshots, lastConfig.decimals, lastConfig.symbol));
  });
  $('btn-dl-series').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCSV('timeseries.csv', buildTimeseriesCSV(lastResult.series, lastConfig.decimals));
  });

  $('chain').addEventListener('change', () => applyPreset($('chain').value, false));
  ['startBlock', 'endBlock', 'stepBlocks'].forEach((id) => $(id).addEventListener('input', snapshotCount));

  // Claimer source: show the file input only in CSV mode.
  const fileInput = $('claimersFile');
  document.querySelectorAll('input[name=claimerSource]').forEach((r) => {
    r.addEventListener('change', () => {
      fileInput.classList.toggle('hidden', r.value !== 'csv' || !r.checked);
      if (r.value === 'csv' && r.checked && !claimersCSVText) fileInput.click();
    });
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    claimersCSVText = await f.text();
    $('claimers-note').className = 'note ok';
    $('claimers-note').textContent = `✓ ${f.name} (${(f.size / 1024).toFixed(1)} kB) — wallets are deduped and filtered by min claimed`;
  });
  if (document.querySelector('input[name=claimerSource]:checked').value === 'csv') {
    fileInput.classList.remove('hidden');
  }

  // Persist the form as the user edits (the "remember last config" requirement).
  document.querySelectorAll('#config-form input, #config-form select').forEach((elm) => {
    elm.addEventListener('change', () => store.saveFormConfig(readForm()));
  });
}

init();

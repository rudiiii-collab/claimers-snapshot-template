// Aero MetaDEX03 incentive-only claims. Wallet = topic2 (recipient), not
// topic1 (veNFT tokenId). ClaimFees is NEVER requested or counted.
import {
  addressTopic, topicToAddress, dataWords, hexToBig, lower, encUint,
  topicIncentiveCreated, topicClaimIncentives,
} from './abi.js';
import { isRangeError, parseSuggestedRange } from './rpc.js';
import { formatUnits } from './csv.js';

/** Chunked inclusive log scan shared by claims and CL pool discovery. */
export async function scanLogs(client, address, start, end, topics, onProgress, chunkBlocks = 50000n) {
  let chunk = chunkBlocks > 0n ? BigInt(chunkBlocks) : 50000n;
  const result = [];
  const span = end - start + 1n;
  for (let from = start; from <= end;) {
    const to = from + chunk - 1n < end ? from + chunk - 1n : end;
    let logs;
    try {
      logs = await client.getLogs(address, from, to, topics);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (isRangeError(err) && to > from) {
        let nc = BigInt(parseSuggestedRange(err.message) || 0);
        if (nc === 0n || nc >= chunk) nc = chunk / 2n;
        if (nc < 1n) nc = 1n;
        onProgress?.({ phase: 'scan', note: `provider rejected ${chunk}-block range; shrinking to ${nc}` });
        chunk = nc;
        continue;
      }
      throw new Error(`getLogs [${from},${to}]: ${err.message}`);
    }
    result.push(...logs);
    from = to + 1n;
    onProgress?.({ phase: 'scan', done: Number(from - start), total: Number(span),
      note: `scanned to block ${to} — ${result.length} logs` });
  }
  return result;
}

/** Scan programs from manager creation, then only incentive claims in [start,end].
 * Returns [{wallet, block, amount}] with exact BigInt amounts. Diagnostic totals
 * are BEFORE the wallet MIN_CLAIMED filter, and include zero-claim programs.
 */
export async function scanClaimEvents(client, cfg, start, end, onProgress) {
  const programStart = cfg.programScanStart ?? cfg.startBlock ?? start;
  if (programStart < 0n || programStart > start) throw new Error('Program scan start must be between zero and Start block.');
  const token = lower(cfg.token);
  const created = await scanLogs(client, cfg.votingReward, programStart, end,
    [topicIncentiveCreated, null, addressTopic(token)], onProgress, cfg.chunkBlocks);
  const programs = new Map();
  for (const log of created) {
    if (log.topics?.length !== 4 || lower(log.topics[0]) !== topicIncentiveCreated ||
        lower(topicToAddress(log.topics[2])) !== token) continue;
    programs.set(hexToBig(log.topics[1]).toString(), { count: 0, amount: 0n });
  }
  const ids = [...programs.keys()].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  onProgress?.({ phase: 'scan', audit: true,
    note: `Incentive programs: ${ids.map((id) => `${id} -> ${token}`).join(', ') || 'none'}. ClaimFees excluded.` });
  const logs = ids.length ? await scanLogs(client, cfg.votingReward, start, end,
    [topicClaimIncentives, null, null, ids.map((id) => '0x' + encUint(id))],
    onProgress, cfg.chunkBlocks) : [];
  const events = [];
  let total = 0n;
  for (const log of logs) {
    if (log.topics?.length !== 4 || lower(log.topics[0]) !== topicClaimIncentives) continue;
    const stats = programs.get(hexToBig(log.topics[3]).toString());
    const words = dataWords(log.data);
    if (!stats || !words.length) continue;
    const amount = hexToBig('0x' + words[0]);
    events.push({ wallet: lower(topicToAddress(log.topics[2])), block: BigInt(log.blockNumber), amount });
    stats.count++;
    stats.amount += amount;
    total += amount;
  }
  for (const id of ids) {
    const { count, amount } = programs.get(id);
    onProgress?.({ phase: 'scan', audit: true,
      note: `ClaimIncentives program ${id}: ${count} events, ${formatUnits(amount, cfg.decimals)} ${cfg.symbol || 'tokens'} (${amount} raw), before MIN_CLAIMED` });
  }
  onProgress?.({ phase: 'scan', audit: true,
    note: `Incentives total: ${events.length} events, ${formatUnits(total, cfg.decimals)} ${cfg.symbol || 'tokens'} (${total} raw), before MIN_CLAIMED; ClaimFees excluded` });
  return events;
}

/** Sum each wallet's claimed amount up to and including `block`. Map wallet->BigInt. */
export function cumulativeClaimed(events, block) {
  const out = new Map();
  for (const e of events) {
    if (e.block > block) continue;
    out.set(e.wallet, (out.get(e.wallet) || 0n) + e.amount);
  }
  return out;
}

/**
 * Build the claimer list from scanned events — the Dune query:
 *   GROUP BY wallet HAVING SUM(amount/10^decimals) > MIN_CLAIMED
 * Returns [{wallet, raw}] sorted descending by claimed.
 */
export function claimersFromEvents(events, cfg) {
  const totals = new Map();
  for (const e of events) {
    totals.set(e.wallet, (totals.get(e.wallet) || 0n) + e.amount);
  }
  return filterAndSort(totals, cfg);
}

/**
 * Build the claimer list from a reference CSV — port of ImportClaimers.
 * The reference may list a wallet on multiple rows (one per claim/epoch); rows
 * are AGGREGATED per wallet before the MIN_CLAIMED filter. Deduping is
 * essential: the cumulative-claimed path assigns each row the wallet's full
 * per-block total, so duplicate rows would multiply that wallet's contribution.
 *
 * Supported layouts (columns located by header name):
 *   snapshot CSV: wallet,partner,claimed,...
 *   claimers CSV: wallet,claimed_raw,claimed_decimal (any order)
 */
export function importClaimers(csvText, cfg) {
  const { header, rows } = parseCSV(csvText);
  let wi = 0, ci = 2, ri = -1;
  header.forEach((h, i) => {
    switch (h.trim().toLowerCase()) {
      case 'wallet': wi = i; break;
      case 'claimed': case 'claimed_decimal': ci = i; break;
      case 'claimed_raw': ri = i; break;
    }
  });
  const totals = new Map();
  for (const r of rows) {
    if (r.length <= wi) continue;
    const wallet = lower(r[wi].trim());
    if (!wallet) continue;

    let rawInt = null;
    if (ri >= 0 && r.length > ri) {
      // Exact path: parse the raw base-unit integer directly.
      const s = r[ri].trim();
      if (/^\d+$/.test(s)) rawInt = BigInt(s);
    }
    if (rawInt === null) {
      // Fallback: round-toward-zero of claimed_decimal * 10^decimals.
      if (r.length <= ci) continue;
      const dec = r[ci].trim();
      if (!dec || dec === '<nil>') continue;
      rawInt = decimalToRaw(dec, cfg.decimals);
      if (rawInt === null) continue;
    }
    totals.set(wallet, (totals.get(wallet) || 0n) + rawInt);
  }
  return filterAndSort(totals, cfg);
}

function filterAndSort(totals, cfg) {
  const denom = 10n ** BigInt(cfg.decimals);
  // HAVING SUM(raw)/10^dec > MIN_CLAIMED, compared exactly:
  // raw * minDen > min * denom  (minClaimed parsed as an exact rational).
  const [minNum, minDen] = parseDecimalRational(String(cfg.minClaimed));
  const out = [];
  for (const [wallet, raw] of totals) {
    if (raw * minDen > minNum * denom) out.push({ wallet, raw });
  }
  out.sort((a, b) => (a.raw < b.raw ? 1 : a.raw > b.raw ? -1 : 0));
  return out;
}

/** "123.45" -> [12345n, 100n] exact rational. */
export function parseDecimalRational(s) {
  const m = String(s).trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m) return [0n, 1n];
  const whole = m[1] || '0';
  const frac = m[2] || '';
  return [BigInt(whole + frac), 10n ** BigInt(frac.length)];
}

/** Decimal string -> raw base units (truncating beyond `decimals` digits). */
export function decimalToRaw(dec, decimals) {
  const neg = dec.startsWith('-');
  const m = (neg ? dec.slice(1) : dec).match(/^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  let digits = (m[1] || '') + (m[2] || '');
  let exp = (m[3] ? parseInt(m[3], 10) : 0) - (m[2] || '').length + decimals;
  let v = BigInt(digits || '0');
  if (exp >= 0) v *= 10n ** BigInt(exp);
  else v /= 10n ** BigInt(-exp);
  return neg ? -v : v;
}

/** Tiny CSV parser (handles quoted fields + CRLF). Returns {header, rows}. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0], rows: rows.slice(1) };
}

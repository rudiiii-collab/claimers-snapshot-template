// Persistence — the browser equivalents of the Go tool's data/ directory:
//   localStorage  -> last form config (survives reloads)
//   IndexedDB     -> per-block snapshot checkpoints + claim-event scan cache,
//                    keyed by a hash of the inputs that affect them (so a
//                    changed config never reuses stale data, exactly like the
//                    Go tool's cache-validity checks).

const DB_NAME = 'claimers-snapshot';
const DB_VERSION = 1;
const CONFIG_KEY = 'claimers-config-v1';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints');
      if (!db.objectStoreNames.contains('claimEvents')) db.createObjectStore('claimEvents');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ---- key hashing ----------------------------------------------------------

/** Stable short hash of the inputs that make a cached record valid. */
export async function hashKey(obj) {
  const json = JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- claim-event cache (mirrors data/cache/claim_events.json) --------------

// Valid only for the same (bribe, reward token, scan range, event sig).
export async function loadClaimEventsCache(key) {
  const rec = await tx('claimEvents', 'readonly', (s) => s.get(key));
  if (!rec) return null;
  return rec.events.map((e) => ({ wallet: e.w, block: BigInt(e.b), amount: BigInt(e.a) }));
}

export async function saveClaimEventsCache(key, events) {
  const rec = {
    savedAt: Date.now(),
    events: events.map((e) => ({ w: e.wallet, b: e.block.toString(), a: e.amount.toString() })),
  };
  await tx('claimEvents', 'readwrite', (s) => s.put(rec, key));
}

// ---- block checkpoints (mirror data/cache/block_<n>.json) -------------------

// Valid only for the same (chain, token, pools, staked-only, claimer set hash).
// They hold the EXPENSIVE reads (hold/LP); claimed is recomputed from events.
export async function loadCheckpoint(scopeKey, block) {
  const rec = await tx('checkpoints', 'readonly', (s) => s.get(`${scopeKey}:${block}`));
  if (!rec) return null;
  return {
    timestamp: rec.ts,
    rows: rec.rows.map((r) => ({
      wallet: r.w, claimed: BigInt(r.c), hold: BigInt(r.h), lp: BigInt(r.l),
    })),
  };
}

export async function saveCheckpoint(scopeKey, block, timestamp, rows) {
  const rec = {
    ts: timestamp,
    rows: rows.map((r) => ({
      w: r.wallet, c: r.claimed.toString(), h: r.hold.toString(), l: r.lp.toString(),
    })),
  };
  await tx('checkpoints', 'readwrite', (s) => s.put(rec, `${scopeKey}:${block}`));
}

export async function clearAllCaches() {
  await tx('checkpoints', 'readwrite', (s) => s.clear());
  await tx('claimEvents', 'readwrite', (s) => s.clear());
}

// ---- form config (localStorage) --------------------------------------------

export function saveFormConfig(values) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(values)); } catch { /* private mode */ }
}

export function loadFormConfig() {
  try {
    const s = localStorage.getItem(CONFIG_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

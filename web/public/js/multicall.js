// Multicall3 aggregate3 encode/decode — port of multicall.go. Invoked via
// eth_call with a historical block tag, so every sub-call is evaluated against
// that block's state: a whole snapshot block collapses into a handful of
// requests instead of one per wallet.

import { selector } from './keccak.js';
import { encAddress } from './abi.js';

export const MULTICALL3_ADDR = '0xca11bde05977b3631167028862be2a173976ca11';

export const selAggregate3 = selector('aggregate3((address,bool,bytes)[])');

function strip0x(s) { return s.toLowerCase().replace(/^0x/, ''); }
function wordUint(v) { return BigInt(v).toString(16).padStart(64, '0'); }

/**
 * ABI-encode a Call3[] (each {target, data}). Every call uses allowFailure=true
 * so a single reverting sub-call never aborts the whole batch.
 */
export function encodeAggregate3(calls) {
  const n = calls.length;
  const tails = new Array(n);
  for (let i = 0; i < n; i++) {
    const raw = strip0x(calls[i].data);
    let data = raw;
    const rem = data.length % 64;
    if (rem !== 0) data += '0'.repeat(64 - rem);
    const dataLenBytes = raw.length / 2;
    // tuple: address, allowFailure(=1), offset-to-bytes(=0x60), len, bytes...
    tails[i] = encAddress(calls[i].target) + wordUint(1) + wordUint(0x60) + wordUint(dataLenBytes) + data;
  }
  // Head: n offset words (relative to start of data after the length word).
  let heads = '';
  let off = n * 32;
  for (let i = 0; i < n; i++) {
    heads += wordUint(off);
    off += tails[i].length / 2;
  }
  const arrayBody = wordUint(n) + heads + tails.join('');
  // Top-level: single dynamic arg, offset 0x20.
  return selAggregate3 + wordUint(0x20) + arrayBody;
}

function wordAt(h, byteOff) {
  const start = byteOff * 2;
  if (start + 64 > h.length) return null;
  return h.slice(start, start + 64);
}

function hexUintAt(h, byteOff) {
  const w = wordAt(h, byteOff);
  if (w === null) return null;
  return Number(BigInt('0x' + w));
}

/** Decode the Result[] = (bool success, bytes returnData)[]. */
export function decodeAggregate3(ret) {
  const h = strip0x(ret);
  const arrOff = hexUintAt(h, 0);
  if (arrOff === null) throw new Error('multicall: short return');
  const n = hexUintAt(h, arrOff);
  if (n === null) throw new Error('multicall: bad array length');
  const dataStart = arrOff + 32; // element head offsets are relative to here
  const out = [];
  for (let i = 0; i < n; i++) {
    const elemOff = hexUintAt(h, dataStart + i * 32);
    if (elemOff === null) throw new Error(`multicall: bad element offset ${i}`);
    const elemStart = dataStart + elemOff;
    const succWord = wordAt(h, elemStart);
    if (succWord === null) throw new Error(`multicall: bad success word ${i}`);
    const success = BigInt('0x' + succWord) !== 0n;
    const bytesOff = hexUintAt(h, elemStart + 32);
    if (bytesOff === null) throw new Error(`multicall: bad bytes offset ${i}`);
    const lenPos = elemStart + bytesOff;
    const blen = hexUintAt(h, lenPos);
    if (blen === null) throw new Error(`multicall: bad bytes len ${i}`);
    const dataPos = (lenPos + 32) * 2;
    let end = dataPos + blen * 2;
    if (end > h.length) end = h.length;
    const retData = dataPos <= h.length ? '0x' + h.slice(dataPos, end) : '';
    out.push({ success, ret: retData });
  }
  return out;
}

/** Multicall result word as BigInt (0n on failure/empty) — resultUint in Go. */
export function resultUint(cr) {
  if (!cr.success || !cr.ret || cr.ret === '0x') return 0n;
  const r = cr.ret.replace(/^0x/, '');
  return BigInt('0x' + (r.length >= 64 ? r.slice(0, 64) : r));
}

/**
 * Execute calls via Multicall3 at `block`, chunking into batches of batchSize
 * and preserving overall order. `client` is an rpc.js Client.
 */
export async function multiCall(client, calls, block, batchSize) {
  if (!batchSize || batchSize <= 0) batchSize = 500;
  const results = [];
  for (let i = 0; i < calls.length; i += batchSize) {
    const slice = calls.slice(i, Math.min(i + batchSize, calls.length));
    const data = encodeAggregate3(slice);
    const ret = await client.ethCall(MULTICALL3_ADDR, data, block);
    const decoded = decodeAggregate3(ret);
    if (decoded.length !== slice.length) {
      throw new Error(`multicall [${i},${i + slice.length}): expected ${slice.length} results got ${decoded.length}`);
    }
    results.push(...decoded);
  }
  return results;
}

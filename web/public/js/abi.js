// Minimal ABI helpers — direct port of abi.go. Selectors and topics are derived
// from signatures via Keccak-256 at module load (no magic numbers).

import { selector, topic0 } from './keccak.js';

export const sel = {
  balanceOf: selector('balanceOf(address)'),
  totalSupply: selector('totalSupply()'),
  decimals: selector('decimals()'),
  symbol: selector('symbol()'),
  token0: selector('token0()'),
  token1: selector('token1()'),
  getReserves: selector('getReserves()'),
  // CL (Slipstream) path.
  slot0: selector('slot0()'),
  tickSpacing: selector('tickSpacing()'),
  tokenOfOwnerByIndex: selector('tokenOfOwnerByIndex(address,uint256)'),
  positions: selector('positions(uint256)'),
  gauge: selector('gauge()'),
  stakedValues: selector('stakedValues(address)'),
  nft: selector('nft()'),
};

// Aero MetaDEX03 VotingRewardsManager. Fees are defined for identification
// and negative fixtures ONLY; claimed always excludes ClaimFees.
export const CLAIM_FEES_SIG = 'ClaimFees(uint256,address,address,uint256)';
export const CLAIM_INCENTIVES_SIG = 'ClaimIncentives(uint256,address,uint256,uint256)';
export const INCENTIVE_CREATED_SIG = 'IncentiveCreated(uint256,address,address,uint256,uint48,uint48)';
export const topicClaimFees = topic0(CLAIM_FEES_SIG);
export const topicClaimIncentives = topic0(CLAIM_INCENTIVES_SIG);
export const topicIncentiveCreated = topic0(INCENTIVE_CREATED_SIG);

// Aero CLFactory: indexed token0, token1, int24 tickSpacing; data[0] = pool.
export const topicPoolCreated = topic0('PoolCreated(address,address,int24,address)');

/** Left-pad a 20-byte address to a 32-byte ABI word (no 0x). */
export function encAddress(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  return a.padStart(64, '0');
}

/** Left-pad a BigInt/number to a 32-byte ABI word (no 0x). */
export function encUint(v) {
  return BigInt(v).toString(16).padStart(64, '0');
}

export function callDataBalanceOf(wallet) { return sel.balanceOf + encAddress(wallet); }

/** Address padded into a 32-byte topic value for log filtering. */
export function addressTopic(addr) { return '0x' + encAddress(addr); }

/** Extract a 20-byte address from a 32-byte indexed topic word. */
export function topicToAddress(topic) {
  const t = topic.replace(/^0x/, '');
  if (t.length < 40) return '0x' + t;
  return '0x' + t.slice(-40).toLowerCase();
}

/** Read the address from a single-word eth_call return. */
export function returnAddress(ret) {
  const r = (ret || '').replace(/^0x/, '');
  if (r.length < 40) return '';
  return '0x' + r.slice(-40).toLowerCase();
}

/** 0x-hex (any length) -> BigInt, '' -> 0n. */
export function hexToBig(h) {
  const s = (h || '').replace(/^0x/, '');
  if (s === '') return 0n;
  return BigInt('0x' + s);
}

/** Read the first 32-byte word of an eth_call return as BigInt. */
export function returnUint(ret) {
  const r = (ret || '').replace(/^0x/, '');
  if (r.length < 64) return hexToBig(ret);
  return hexToBig('0x' + r.slice(0, 64));
}

/** Split 0x-hex data into 32-byte (64 hex char) words. */
export function dataWords(data) {
  const d = (data || '').replace(/^0x/, '');
  const words = [];
  for (let i = 0; i + 64 <= d.length; i += 64) words.push(d.slice(i, i + 64));
  return words;
}

/** First two getReserves() outputs. */
export function parseReserves(ret) {
  const w = dataWords(ret);
  if (w.length < 2) throw new Error(`getReserves: short return ${ret}`);
  return { reserve0: hexToBig('0x' + w[0]), reserve1: hexToBig('0x' + w[1]) };
}

/** Decode an ABI-encoded dynamic string return (offset,len,bytes). */
export function decodeString(ret) {
  const w = dataWords(ret);
  if (w.length < 2) return '';
  const length = Number(hexToBig('0x' + w[1]));
  const raw = (ret || '').replace(/^0x/, '');
  const start = 64 * 2;
  const end = Math.min(start + length * 2, raw.length);
  let s = '';
  for (let i = start; i + 2 <= end; i += 2) s += String.fromCharCode(parseInt(raw.slice(i, i + 2), 16));
  return s;
}

/** Decode an ABI-encoded uint256[] return. */
export function decodeUintArray(ret) {
  const w = dataWords(ret);
  if (w.length < 2) return [];
  // w[0] = offset (0x20), w[1] = length, then elements.
  const n = Number(hexToBig('0x' + w[1]));
  const out = [];
  for (let i = 0; i < n && 2 + i < w.length; i++) out.push(hexToBig('0x' + w[2 + i]));
  return out;
}

/** Decode a 32-byte ABI word holding a sign-extended int24 tick. */
export function signedTick(word) {
  let v = hexToBig('0x' + word);
  const half = 1n << 255n;
  if (v >= half) v -= 1n << 256n;
  return Number(v);
}

/** Lower-cased 0x address equality-ready normalization. */
export function lower(addr) { return (addr || '').toLowerCase(); }

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export function hasAddr(a) { return !!a && a !== ZERO_ADDR; }

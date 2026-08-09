// Self-contained Keccak-256 (the pre-NIST padding Ethereum uses), mirroring the
// repo's keccak.go: selectors and event topics are DERIVED from signatures, so
// nothing in the app is a guessed magic number. Verified against the vectors in
// keccak_test.go (see web/test/run-tests.mjs).

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PIL = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;

function rotl(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
}

function keccakF(a) {
  const b = new Array(5), t = new Array(25);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) b[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = b[(x + 4) % 5] ^ rotl(b[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    // rho + pi
    let last = a[1];
    for (let i = 0; i < 24; i++) {
      const j = PIL[i];
      const tmp = a[j];
      a[j] = rotl(last, ROTC[i]);
      last = tmp;
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) t[x] = a[y + x];
      for (let x = 0; x < 5; x++) a[y + x] = t[x] ^ (~t[(x + 1) % 5] & MASK & t[(x + 2) % 5]);
    }
    // iota
    a[0] ^= RC[round];
  }
}

/** keccak256(bytes: Uint8Array) -> 32-byte Uint8Array */
export function keccak256(bytes) {
  const rate = 136; // 1088-bit rate for 256-bit output
  const state = new Array(25).fill(0n);

  // Absorb full blocks, then the padded final block (pad10*1 with 0x01 domain).
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      state[i] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const HEX = '0123456789abcdef';
export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}

function utf8(s) { return new TextEncoder().encode(s); }

/** 4-byte function selector from a signature string, 0x-prefixed. */
export function selector(sig) {
  return '0x' + bytesToHex(keccak256(utf8(sig)).slice(0, 4));
}

/** 32-byte event topic0 from a signature string, 0x-prefixed. */
export function topic0(sig) {
  return '0x' + bytesToHex(keccak256(utf8(sig)));
}

// Minimal, rate-limited, retrying JSON-RPC client — port of rpc.go.
// Adds one browser-specific concern: if a provider blocks cross-origin
// requests, the client transparently retries through the /api/rpc Pages
// Function proxy (see functions/api/rpc.js).

export class RpcError extends Error {
  constructor(code, message) {
    super(`rpc error ${code}: ${message}`);
    this.code = code;
    this.rpcMessage = message;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** "eth_getLogs block range too large" style errors (Alchemy 10-block cap etc). */
export function isRangeError(err) {
  if (!err) return false;
  const m = String(err.message || err).toLowerCase();
  return m.includes('block range') || m.includes('range should work') ||
    m.includes('query returned more than') || m.includes('logs matched') ||
    m.includes('too many results') || m.includes('response size') ||
    m.includes('limited to'); // mainnet.base.org: "eth_getLogs is limited to a 10,000 range"
}

/** Pull a provider-suggested working range out of "...should work: [0x.., 0x..]". */
export function parseSuggestedRange(msg) {
  const ms = String(msg).match(/0x[0-9a-fA-F]+/g);
  if (ms && ms.length >= 2) {
    const a = BigInt(ms[ms.length - 2]);
    const b = BigInt(ms[ms.length - 1]);
    if (b >= a) return Number(b - a + 1n);
  }
  return 0;
}

function isRetryable(msg) {
  const m = String(msg).toLowerCase();
  return ['rate', 'limit', 'timeout', 'busy', 'capacity', 'try again', '429']
    .some((s) => m.includes(s));
}

export class Client {
  /**
   * @param {string} url JSON-RPC endpoint
   * @param {number} ratePerSecond max requests/sec (default 8, like the Go tool)
   * @param {number} maxRetries
   * @param {AbortSignal=} signal cancels in-flight work
   */
  constructor(url, ratePerSecond = 8, maxRetries = 6, signal = undefined) {
    this.url = url;
    this.interval = 1000 / (ratePerSecond > 0 ? ratePerSecond : 8);
    this.maxRetries = maxRetries;
    this.signal = signal;
    this.id = 0;
    this.nextSlot = 0;   // rate limiter: next allowed send time
    this.useProxy = false; // flips on after a CORS/network failure
    this.stats = { requests: 0, retries: 0 };
  }

  async throttle() {
    const now = Date.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.interval;
    if (wait > 0) await sleep(wait);
  }

  async post(body) {
    const target = this.useProxy
      ? `/api/rpc?url=${encodeURIComponent(this.url)}`
      : this.url;
    return fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: this.signal,
    });
  }

  /** One JSON-RPC request with rate limiting + exponential backoff. */
  async call(method, ...params) {
    this.id++;
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.id, method, params });

    let lastErr = null;
    let backoff = 500;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      await this.throttle();
      this.stats.requests++;
      try {
        let resp;
        try {
          resp = await this.post(body);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // Likely CORS or network. Try the proxy once before counting a retry.
          if (!this.useProxy) {
            this.useProxy = true;
            resp = await this.post(body);
          } else {
            throw e;
          }
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          const out = await resp.json();
          if (out.error) {
            // Retry transient rate/limit errors; fail fast on the rest.
            const err = new RpcError(out.error.code, out.error.message);
            if (isRetryable(out.error.message)) lastErr = err;
            else throw err;
          } else {
            return out.result;
          }
        }
      } catch (e) {
        if (e.name === 'AbortError' || e instanceof RpcError) throw e;
        lastErr = e;
      }
      if (attempt < this.maxRetries) {
        this.stats.retries++;
        await sleep(backoff);
        if (backoff < 16000) backoff *= 2;
      }
    }
    throw new Error(`rpc ${method} failed after ${this.maxRetries} retries: ${lastErr}`);
  }

  async blockNumber() {
    return BigInt(await this.call('eth_blockNumber'));
  }

  /** Read-only call at a block. `block` is a BigInt/number; data is 0x-hex. */
  async ethCall(to, data, block) {
    return this.call('eth_call', { to, data: data.startsWith('0x') ? data : '0x' + data }, blockTag(block));
  }

  /**
   * Logs for [from,to] inclusive. topics entries may be null (wildcard).
   * Returns raw log objects ({address, topics, data, blockNumber, ...}).
   */
  async getLogs(address, fromBlock, toBlock, topics) {
    const filter = { fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock) };
    if (address) filter.address = address;
    if (topics && topics.length) filter.topics = topics;
    return (await this.call('eth_getLogs', filter)) || [];
  }

  async blockTimestamp(block) {
    const b = await this.call('eth_getBlockByNumber', blockTag(block), false);
    return b ? Number(BigInt(b.timestamp)) : 0;
  }
}

export function blockTag(n) { return '0x' + BigInt(n).toString(16); }

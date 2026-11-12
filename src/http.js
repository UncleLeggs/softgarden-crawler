import { config } from './config.js';
import { log } from './logger.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BlockedError extends Error {
  constructor(host) {
    super(`${host} returned 403 (WAF "Request blocked"). The IP is being throttled -- `
      + `wait 15-30 min and retry, or lower SG_RPS.`);
    this.name = 'BlockedError';
  }
}

// Global limiter: caps in-flight requests AND requests per second. Both matter
// here -- Cloudflare throttles on burst rate, not just concurrency.
export class Limiter {
  #active = 0;
  #queue = [];
  #nextSlot = 0;

  constructor(concurrency, rps) {
    this.concurrency = Math.max(1, concurrency);
    this.minGap = rps > 0 ? 1000 / rps : 0;
  }

  async run(fn) {
    // `while`, not `if`: releasing a slot wakes a waiter, but a brand new caller
    // can claim that slot before the waiter's continuation runs. A waiter that
    // assumed the slot was still free would push #active past the ceiling.
    while (this.#active >= this.concurrency) {
      await new Promise((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      // Claim this request's slot synchronously, BEFORE any await. Reading a
      // deadline, sleeping, and only then stamping it lets every concurrent
      // caller compute the same deadline and fire together -- which makes the
      // real rate concurrency x rps rather than rps.
      const now = Date.now();
      const at = Math.max(now, this.#nextSlot);
      this.#nextSlot = at + this.minGap;
      const wait = at - now;
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

export const limiter = new Limiter(config.concurrency, config.rps);

/**
 * Fetch with backoff. Retries 429 and 5xx (honouring Retry-After) and network
 * errors. Does NOT retry 403: on data.commoncrawl.org that is a WAF block that
 * lasts minutes, so hammering it makes things worse.
 */
export async function request(url, {
  retries = 4, timeoutMs = 60_000, ua = config.scriptUA, method = 'GET',
  headers = {}, body, redirect = 'follow', label,
} = {}) {
  const name = label ?? url;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await limiter.run(() => fetch(url, {
        method, body, redirect,
        headers: { 'user-agent': ua, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      }));
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = 2000 * 2 ** attempt;
      log.debug(`retry ${attempt + 1}/${retries} in ${wait}ms (${err.name === 'TimeoutError' ? 'timeout' : err.message}) ${name}`);
      await sleep(wait);
      continue;
    }

    if (res.status === 403 && new URL(url).host === 'data.commoncrawl.org') {
      throw new BlockedError('data.commoncrawl.org');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
      log.debug(`retry ${attempt + 1}/${retries} in ${wait}ms (HTTP ${res.status}) ${name}`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

export async function requestText(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return { text: await res.text(), finalUrl: res.url, status: res.status };
}

export async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// Bounded worker pool.
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); }
      catch (err) { out[i] = { error: err.message }; }
      onProgress?.(++done, items.length);
    }
  }));
  return out;
}

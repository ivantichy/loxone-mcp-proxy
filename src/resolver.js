import logger from './logger.js';

/**
 * Resolves the Miniserver's *current* relay endpoint via the stable Loxone
 * Cloud "connect" URL, which issues a 307 redirect to whatever relay/address
 * is live right now. That target rotates often (and the connect endpoint is
 * rate-limited to ~10 requests/window), so we cache the result and only hit
 * connect on cold start or after a failure.
 */
export class EndpointResolver {
  constructor({ serial, connectBase = 'https://connect.loxonecloud.com', fetchImpl = fetch, log = logger, minIntervalMs = 2000 }) {
    if (!serial) throw new Error('EndpointResolver: serial is required');
    this.serial = serial;
    this.connectBase = connectBase.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.log = log;
    this.minIntervalMs = minIntervalMs;
    this._lastCall = 0;
    this._cachedEntry = null;
  }

  get connectUrl() {
    return `${this.connectBase}/${this.serial}/mcp`;
  }

  /**
   * Return the current relay entry origin, e.g.
   * "https://1-2-3-4.<serial>.dyndns.loxonecloud.com:12345".
   * Cached unless {force:true}.
   */
  async resolve({ force = false } = {}) {
    if (!force && this._cachedEntry) return this._cachedEntry;
    await this._respectRateLimit();

    const url = this.connectUrl;
    this.log.debug('resolver: GET', url);
    let res;
    try {
      res = await this.fetch(url, { redirect: 'manual' });
    } catch (e) {
      throw new ResolveError(`connect request failed: ${e.message}`, { retryable: true });
    }

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) || undefined;
      throw new ResolveError('connect is rate-limited (HTTP 429)', { retryable: true, resetEpoch: reset });
    }

    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      let u;
      try {
        u = new URL(loc);
      } catch {
        throw new ResolveError(`connect returned an invalid redirect location: ${loc}`, { retryable: false });
      }
      // The entry receives the login credentials and Bearer tokens — never
      // accept a plaintext (or otherwise non-HTTPS) target for it.
      if (u.protocol !== 'https:') {
        throw new ResolveError(`connect redirected to a non-HTTPS origin (${u.origin}) — refusing to send credentials over it`, { retryable: false });
      }
      this._cachedEntry = u.origin;
      this.log.debug('resolver: entry =', u.origin);
      return u.origin;
    }

    throw new ResolveError(`connect did not redirect (HTTP ${res.status})`, { retryable: res.status >= 500 });
  }

  /** Forget the cached entry so the next resolve() hits connect again. */
  invalidate() {
    this._cachedEntry = null;
  }

  async _respectRateLimit() {
    const wait = this._lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) {
      this.log.debug(`resolver: throttling ${wait}ms to respect connect rate limit`);
      await sleep(wait);
    }
    this._lastCall = Date.now();
  }
}

export class ResolveError extends Error {
  constructor(message, { retryable = true, resetEpoch } = {}) {
    super(message);
    this.name = 'ResolveError';
    this.retryable = retryable;
    this.resetEpoch = resetEpoch;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

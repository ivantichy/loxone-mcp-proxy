import logger from './logger.js';
import { sleep } from './resolver.js';

/**
 * Owns the live connection to the Loxone MCP endpoint: endpoint resolution,
 * headless OAuth, token refresh, the streamable-HTTP session, and transparent
 * recovery when the relay rotates or dies (e.g. on a Miniserver restart).
 * Callers just call send(); everything else is hidden.
 */
export class Connection {
  constructor({ resolver, auth, cache, log = logger, fetchImpl = fetch, maxAuthAttempts = 6, requestTimeoutMs = 120_000 }) {
    this.resolver = resolver;
    this.auth = auth;
    this.cache = cache;
    this.log = log;
    this.fetch = fetchImpl;
    this.maxAuthAttempts = maxAuthAttempts;
    this.requestTimeoutMs = requestTimeoutMs;

    this.state = null; // {entryOrigin,resource,clientId,accessToken,refreshToken,tokenType,expiresAt}
    this._authInflight = null;
    // Optional hook: fired whenever an MCP session is (re-)established —
    // the client's initialize as well as every transparent replay. The state
    // warmer uses it; failures in the hook never affect the pipe.
    this.onSessionEstablished = null;
    this.sessionId = null;
    this.protocolVersion = null;
    this.initMessage = null; // remembered "initialize" request for transparent replay
    this._initInflight = null; // single-flight guard for the session handshake

    const cached = this.cache?.load?.();
    if (cached && cached.accessToken) {
      this.state = { ...cached };
      this.log.debug('connection: loaded cached token for resource', cached.resource);
    }
  }

  _tokenValid() {
    return !!(this.state?.accessToken && this.state.expiresAt && this.state.expiresAt - Date.now() > 60_000);
  }

  _saveCache() {
    if (this.cache && this.state) this.cache.save(this.state);
  }

  /** The MCP endpoint we actually talk to: the reachable connect-resolved entry.
   *  The OAuth `resource` is only the token *audience*, not a connection target —
   *  the metadata often advertises a stale/unreachable relay there. */
  _mcpUrl() {
    return `${this.state.entryOrigin}/mcp`;
  }

  /** Re-resolve the entry relay while keeping the current token (its audience is
   *  the Miniserver identity, so any live relay accepts it). Falls back to a full
   *  re-auth if resolution fails. */
  async _reresolveEntry() {
    try {
      this.resolver.invalidate();
      const entry = await this.resolver.resolve({ force: true });
      this.state.entryOrigin = entry;
      this._saveCache();
      this.log.info('connection: re-resolved entry to', entry);
    } catch (e) {
      this.log.warn('connection: re-resolve failed, re-authenticating:', e.message);
      await this.ensureAuth({ force: true });
    }
  }

  /** Ensure we hold a valid access token. Refresh if possible, else full login.
   *  Single-flight: concurrent callers (startup warmup vs the first request)
   *  share one auth run instead of racing two full logins. */
  async ensureAuth({ force = false } = {}) {
    if (this._authInflight) {
      if (!force) return this._authInflight;
      await this._authInflight.catch(() => {}); // let the running attempt settle, then force
    }
    const p = this._ensureAuthNow(force).finally(() => {
      if (this._authInflight === p) this._authInflight = null;
    });
    this._authInflight = p;
    return p;
  }

  async _ensureAuthNow(force) {
    if (!force && this._tokenValid()) return;

    if (!force && this.state?.refreshToken && this.state?.entryOrigin && this.state?.resource && this.state?.clientId) {
      try {
        const t = await this.auth.refresh(this.state.entryOrigin, {
          clientId: this.state.clientId,
          refreshToken: this.state.refreshToken,
          resource: this.state.resource,
        });
        // If the endpoint didn't rotate the refresh token, keep the one we
        // have — clobbering it with null would force a full login next time.
        this.state = { ...this.state, ...t, refreshToken: t.refreshToken ?? this.state.refreshToken };
        this._saveCache();
        this.log.info('connection: access token refreshed');
        return;
      } catch (e) {
        this.log.warn('connection: refresh failed, falling back to full login:', e.message);
      }
    }
    await this._fullAuth();
  }

  async _fullAuth() {
    let lastErr;
    for (let attempt = 1; attempt <= this.maxAuthAttempts; attempt++) {
      try {
        const entry = await this.resolver.resolve({ force: attempt > 1 });
        const res = await this.auth.authorize(entry);
        this.state = { entryOrigin: entry, ...res };
        this.sessionId = null; // fresh auth => need a new MCP session
        this.protocolVersion = null;
        this._saveCache();
        this.log.info(`connection: authorized (attempt ${attempt}); resource ${res.resource}`);
        return;
      } catch (e) {
        lastErr = e;
        this.log.warn(`connection: auth attempt ${attempt}/${this.maxAuthAttempts} failed: ${e.message}`);
        // A definitive rejection (wrong credentials, access denied) will not
        // improve with another attempt or relay — fail fast instead of
        // hammering the Miniserver login and risking a user lockout.
        if (e.retryable === false) break;
        this.resolver.invalidate();
        if (attempt < this.maxAuthAttempts) await sleep(backoff(attempt));
      }
    }
    throw new Error(`could not authenticate after ${this.maxAuthAttempts} attempts: ${lastErr?.message || 'unknown error'}`);
  }

  /**
   * Send a JSON-RPC message and return an array of response messages
   * (empty for notifications / 202 Accepted). Recovers transparently from
   * expired tokens, lost sessions and relay rotation, surfacing the underlying
   * error if recovery ultimately fails.
   */
  async send(message) {
    if (message && message.method === 'initialize') this.initMessage = message;
    await this.ensureAuth();

    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        if (!this.sessionId && this.initMessage && message.method !== 'initialize') {
          await this._replayInit();
        }
        const messages = await this._post(message);
        if (message.method === 'initialize' && messages.some((m) => m && m.result)) {
          this._sessionEstablished();
        }
        return messages;
      } catch (e) {
        lastError = e;
        if (e instanceof Unauthorized) {
          this.log.warn('connection: 401 from endpoint; re-authenticating');
          // First 401: invalidate expiry so ensureAuth tries the cheap refresh
          // before a full credential login; repeated 401s force the full login.
          if (this.state) this.state.expiresAt = 0;
          await this.ensureAuth({ force: attempt > 1 });
        } else if (e instanceof SessionExpired) {
          this.log.warn('connection: MCP session expired; will re-initialize');
          this.sessionId = null;
          this.protocolVersion = null;
        } else if (e instanceof TimeoutError) {
          // Never blind-retry a timed-out call: the remote may still execute it
          // (e.g. control_command), and a retry could run the command twice.
          // Heal the connection for subsequent requests, surface the timeout.
          this.log.warn(`connection: ${e.message}; re-resolving relay for subsequent requests`);
          this.sessionId = null;
          await this._reresolveEntry();
          throw e;
        } else if (e instanceof NetworkError) {
          this.log.warn(`connection: network error (${e.message}); re-resolving relay`);
          await this._reresolveEntry();
          this.sessionId = null;
        } else {
          throw e;
        }
        if (attempt < 4) await sleep(backoff(attempt));
      }
    }
    throw new Error(`send failed after recovery attempts: ${lastError?.message || 'unknown error'}`);
  }

  /** Re-run the initialize handshake against a fresh session (transparent to Claude). */
  /**
   * Re-establish the MCP session, at most one handshake at a time.
   * Without this guard two callers that both see `sessionId === null` — e.g. a
   * real request and the StateWarmer timer, which runs outside the request
   * queue — each send their own `initialize`. The reply that lands last wins,
   * so the other caller ends up holding a session id the relay has already
   * replaced, which shows up as spurious "session expired" errors and repeated
   * handshakes. Mirrors the `_authInflight` guard used for token refresh.
   */
  async _replayInit() {
    if (this._initInflight) return this._initInflight;
    const p = this._replayInitNow().finally(() => {
      if (this._initInflight === p) this._initInflight = null;
    });
    this._initInflight = p;
    return p;
  }

  async _replayInitNow() {
    this.log.debug('connection: replaying initialize handshake');
    await this._post(this.initMessage);
    try {
      await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (e) {
      this.log.debug('connection: initialized notification failed (non-fatal):', e.message);
    }
    this._sessionEstablished();
  }

  _sessionEstablished() {
    try {
      this.onSessionEstablished?.();
    } catch (e) {
      this.log.warn('connection: onSessionEstablished hook failed:', e.message);
    }
  }

  async _post(message) {
    const headers = {
      authorization: `${this.state.tokenType || 'Bearer'} ${this.state.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;

    // Bound every request: a relay that accepts the TCP connection but never
    // completes the response (or holds an SSE stream open with keep-alives
    // forever) must not wedge the proxy. The signal also aborts body reads.
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let res;
    try {
      res = await this.fetch(this._mcpUrl(), { method: 'POST', headers, body: JSON.stringify(message), signal });
    } catch (e) {
      throw isAbort(e) ? new TimeoutError(this.requestTimeoutMs) : new NetworkError(e.message);
    }

    if (res.status === 401) throw new Unauthorized();
    if (res.status >= 500) throw new NetworkError(`HTTP ${res.status}`);
    // 404 with a session = the session was dropped; without one it is most
    // likely a stale cached relay entry — either way, recoverable.
    if (res.status === 404) throw this.sessionId ? new SessionExpired() : new NetworkError('HTTP 404 (stale relay entry?)');
    if (!res.ok && res.status !== 202) {
      const body = await safeText(res);
      // Some relays report a lost session as 400 rather than 404.
      if (this.sessionId && res.status === 400 && /session/i.test(body)) throw new SessionExpired();
      throw new Error(`remote error HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    let messages = [];
    if (res.status !== 202) {
      const ct = res.headers.get('content-type') || '';
      // A failure while reading the body (aborted SSE stream, connection reset
      // mid-response) is a transport problem — classify it so send() runs the
      // same re-resolve recovery as a failed fetch instead of giving up.
      try {
        if (ct.includes('text/event-stream')) messages = await readSSE(res);
        else if (ct.includes('application/json')) {
          const j = await res.json();
          messages = Array.isArray(j) ? j : [j];
        }
      } catch (e) {
        throw isAbort(e) ? new TimeoutError(this.requestTimeoutMs) : new NetworkError(`response body read failed: ${e.message}`);
      }
    }

    for (const m of messages) {
      if (m && m.result && m.result.protocolVersion) this.protocolVersion = m.result.protocolVersion;
    }
    return messages;
  }
}

/** Read a Server-Sent-Events response body to completion, returning parsed JSON messages. */
export async function readSSE(res) {
  const messages = [];
  if (!res.body) return messages;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flushEvent = (raw) => {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      try { messages.push(JSON.parse(data)); } catch { /* ignore keep-alives / partials */ }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // The SSE spec allows LF or CRLF line endings — accept both as the
    // blank-line event boundary.
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      flushEvent(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += decoder.decode(); // flush any pending bytes
  if (buf.trim()) flushEvent(buf); // final event without a trailing blank line
  return messages;
}

export class Unauthorized extends Error { constructor() { super('unauthorized'); this.name = 'Unauthorized'; } }
export class SessionExpired extends Error { constructor() { super('session expired'); this.name = 'SessionExpired'; } }
export class NetworkError extends Error { constructor(m) { super(m); this.name = 'NetworkError'; } }
export class TimeoutError extends Error { constructor(ms) { super(`request timed out after ${ms}ms`); this.name = 'TimeoutError'; } }

function isAbort(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export function backoff(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

import crypto from 'node:crypto';
import logger from './logger.js';

/**
 * Headless OAuth 2.1 client for the Loxone Miniserver MCP plugin.
 *
 * The plugin protects /mcp with OAuth (Bearer). Its authorize endpoint serves
 * a plain server-rendered HTML login form (it "mirrors the Miniserver web
 * login") — no JavaScript, no Loxone crypto handshake — so we can drive the
 * whole flow non-interactively:
 *
 *   1. discover the canonical resource   (…/.well-known/oauth-protected-resource)
 *   2. dynamic client registration        (…/mcp/oauth/register)
 *   3. GET authorize -> parse login form
 *   4. POST username+password+hidden      -> 302 …/callback?code=…
 *   5. exchange code (PKCE)               (…/mcp/oauth/token) -> access+refresh
 *
 * IMPORTANT: `resource` is only the token AUDIENCE identifier; its metadata
 * often points at a stale/unreachable relay. MCP traffic must be sent to the
 * reachable connect "entry" origin, NOT to `resource` (see Connection._mcpUrl).
 */
export class LoxoneAuth {
  constructor({ username, password, fetchImpl = fetch, log = logger, redirectPort = 41678, clientName = 'loxone-mcp-proxy' }) {
    this.username = username;
    this.password = password;
    this.fetch = fetchImpl;
    this.log = log;
    this.clientName = clientName;
    this.redirectUri = `http://localhost:${redirectPort}/callback`;
  }

  /**
   * Run the full headless authorization against a resolved relay entry origin.
   * @returns {Promise<{resource:string, clientId:string, accessToken:string,
   *   refreshToken:string|null, tokenType:string, expiresAt:number}>}
   */
  async authorize(entryOrigin) {
    const resource = await this._discoverResource(entryOrigin);
    const clientId = await this._register(entryOrigin);
    const { verifier, challenge } = pkce();
    const code = await this._login(entryOrigin, { clientId, challenge, resource });
    const tokens = await this._exchange(entryOrigin, { clientId, code, verifier, resource });
    this.log.debug('auth: obtained token, resource =', resource);
    return { resource, clientId, ...tokens };
  }

  /** Refresh an access token. Loxone rotates refresh tokens, so callers should
   *  persist the returned refreshToken. */
  async refresh(entryOrigin, { clientId, refreshToken, resource }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    });
    const res = await this.fetch(`${entryOrigin}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new AuthError(`refresh failed: HTTP ${res.status}`, { status: res.status });
    return normalizeTokens(await res.json());
  }

  async _discoverResource(entryOrigin) {
    const res = await this.fetch(`${entryOrigin}/mcp/.well-known/oauth-protected-resource`);
    if (!res.ok) throw new AuthError(`protected-resource metadata: HTTP ${res.status}`, { status: res.status });
    const j = await res.json();
    if (!j || !j.resource) throw new AuthError('protected-resource metadata is missing "resource"');
    return j.resource;
  }

  async _register(entryOrigin) {
    const res = await this.fetch(`${entryOrigin}/mcp/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!res.ok) throw new AuthError(`client registration: HTTP ${res.status}`, { status: res.status });
    const j = await res.json();
    if (!j.client_id) throw new AuthError('registration response missing client_id');
    return j.client_id;
  }

  async _login(entryOrigin, { clientId, challenge, resource }) {
    const au = new URL(`${entryOrigin}/mcp/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomUUID(),
      resource,
    })) au.searchParams.set(k, v);

    // 1) GET the login form
    const g = await this.fetch(au, { headers: { accept: 'text/html' }, redirect: 'manual' });
    if (g.status !== 200) {
      const loc = g.headers.get('location');
      if (loc) {
        const err = new URL(loc, au).searchParams.get('error');
        if (err) throw new AuthError(`authorize rejected the request: ${err}`);
      }
      throw new AuthError(`authorize returned HTTP ${g.status}; expected the login form`);
    }
    const html = await g.text();
    const form = parseLoginForm(html);
    if (!form) throw new AuthError('could not locate the login form on the authorize page');

    // 2) POST credentials together with the hidden OAuth fields
    const body = new URLSearchParams();
    for (const inp of form.inputs) {
      if (!inp.name) continue;
      if (inp.type === 'password') body.set(inp.name, this.password);
      else if (inp.type === 'text' || /user|name/i.test(inp.name)) body.set(inp.name, this.username);
      else body.set(inp.name, inp.value ?? '');
    }
    const actionUrl = form.action ? new URL(form.action, au) : au;
    const p = await this.fetch(actionUrl, {
      method: (form.method || 'POST').toUpperCase(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });

    const loc = p.headers.get('location');
    if (!loc) {
      if (p.status === 200) {
        throw new AuthError('login was rejected (form re-rendered) — check LOXONE_USER / LOXONE_PASSWORD and that the user may access this Miniserver', { retryable: false });
      }
      throw new AuthError(`login POST returned HTTP ${p.status} with no redirect`);
    }
    const cb = new URL(loc, actionUrl);
    const err = cb.searchParams.get('error');
    if (err) {
      const desc = cb.searchParams.get('error_description') || '';
      throw new AuthError(`authorization failed: ${err} ${desc}`.trim(), { retryable: err !== 'access_denied' });
    }
    const code = cb.searchParams.get('code');
    if (!code) throw new AuthError('no authorization code returned in the callback');
    return code;
  }

  async _exchange(entryOrigin, { clientId, code, verifier, resource }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    });
    const res = await this.fetch(`${entryOrigin}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new AuthError(`token exchange: HTTP ${res.status}`, { status: res.status });
    return normalizeTokens(await res.json());
  }
}

/** Generate a PKCE verifier/challenge (S256). */
export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Parse the first <form> and its <input> elements from an HTML string. */
export function parseLoginForm(html) {
  const formTag = (html.match(/<form\b[^>]*>/i) || [])[0];
  if (!formTag) return null;
  const action = (formTag.match(/action=["']([^"']*)["']/i) || [])[1] || '';
  const method = (formTag.match(/method=["']([^"']*)["']/i) || [])[1] || 'POST';
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => {
    const t = m[0];
    return {
      name: (t.match(/name=["']([^"']*)["']/i) || [])[1],
      type: ((t.match(/type=["']([^"']*)["']/i) || [])[1] || 'text').toLowerCase(),
      value: (t.match(/value=["']([^"']*)["']/i) || [])[1],
    };
  });
  return { action, method, inputs };
}

/** Normalize a token endpoint response into our internal token shape. */
export function normalizeTokens(j) {
  if (!j || !j.access_token) {
    const fields = j && typeof j === 'object' ? Object.keys(j).join(', ') : typeof j;
    throw new AuthError(`token response has no access_token (fields: ${fields})`);
  }
  const expiresInMs = (Number(j.expires_in) || 3600) * 1000;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || null,
    tokenType: j.token_type || 'Bearer',
    // refresh a bit early to avoid races
    expiresAt: Date.now() + expiresInMs,
  };
}

export class AuthError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    // false = a definitive rejection (e.g. wrong credentials) that another
    // attempt or another relay cannot fix — callers should fail fast.
    this.retryable = retryable;
  }
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

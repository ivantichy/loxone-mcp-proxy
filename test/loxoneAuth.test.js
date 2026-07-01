import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LoxoneAuth, parseLoginForm, pkce, normalizeTokens, AuthError } from '../src/loxoneAuth.js';
import { mockFetch, resp, LOGIN_FORM_HTML } from './helpers.js';

const ENTRY = 'https://entry.example:1111';
const silent = { error() {}, warn() {}, info() {}, debug() {} };

function router(u, o) {
  const method = (o.method || 'GET').toUpperCase();
  if (u.includes('/.well-known/oauth-protected-resource')) return resp({ body: JSON.stringify({ resource: 'https://relay.example/mcp' }) });
  if (u.includes('/mcp/oauth/register')) return resp({ status: 201, body: JSON.stringify({ client_id: 'CID' }) });
  if (u.includes('/mcp/oauth/authorize')) {
    if (method === 'GET') return resp({ status: 200, headers: { 'content-type': 'text/html' }, body: LOGIN_FORM_HTML });
    return resp({ status: 302, headers: { location: 'http://localhost:41678/callback?code=THECODE&state=STATE' } });
  }
  if (u.includes('/mcp/oauth/token')) return resp({ body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 }) });
  return null;
}

test('parseLoginForm extracts action, method and inputs', () => {
  const f = parseLoginForm(LOGIN_FORM_HTML);
  assert.equal(f.method, 'POST');
  assert.equal(f.action, '');
  const names = f.inputs.map((i) => i.name);
  assert.ok(names.includes('username'));
  assert.ok(names.includes('password'));
  assert.equal(f.inputs.find((i) => i.name === 'password').type, 'password');
  assert.equal(f.inputs.find((i) => i.name === 'client_id').value, 'CID');
});

test('parseLoginForm returns null when there is no form', () => {
  assert.equal(parseLoginForm('<html><body>no form here</body></html>'), null);
});

test('pkce produces a valid S256 challenge', () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('normalizeTokens maps fields and defaults expiry', () => {
  const t = normalizeTokens({ access_token: 'A', refresh_token: 'R', expires_in: 100 });
  assert.equal(t.accessToken, 'A');
  assert.equal(t.refreshToken, 'R');
  assert.equal(t.tokenType, 'Bearer');
  assert.ok(t.expiresAt > Date.now());
  assert.throws(() => normalizeTokens({}), AuthError);
});

test('authorize() runs the full headless flow and posts credentials', async () => {
  const fetchImpl = mockFetch(router);
  const auth = new LoxoneAuth({ username: 'mcp', password: 'pw', fetchImpl, log: silent });
  const r = await auth.authorize(ENTRY);
  assert.equal(r.resource, 'https://relay.example/mcp');
  assert.equal(r.clientId, 'CID');
  assert.equal(r.accessToken, 'AT');
  assert.equal(r.refreshToken, 'RT');

  const post = fetchImpl.calls.find((c) => c.url.includes('/authorize') && (c.options.method || '').toUpperCase() === 'POST');
  const body = post.options.body.toString();
  assert.match(body, /username=mcp/);
  assert.match(body, /password=pw/);
  // hidden fields must be carried through
  assert.match(body, /code_challenge=CH/);
  assert.match(body, /client_id=CID/);
});

test('authorize() gives a clear error when login is rejected', async () => {
  const badRouter = (u, o) => {
    const method = (o.method || 'GET').toUpperCase();
    if (u.includes('/.well-known/oauth-protected-resource')) return resp({ body: JSON.stringify({ resource: 'https://relay.example/mcp' }) });
    if (u.includes('/mcp/oauth/register')) return resp({ status: 201, body: JSON.stringify({ client_id: 'CID' }) });
    if (u.includes('/mcp/oauth/authorize')) return resp({ status: 200, body: LOGIN_FORM_HTML }); // GET and POST both re-render
    return null;
  };
  const auth = new LoxoneAuth({ username: 'mcp', password: 'bad', fetchImpl: mockFetch(badRouter), log: silent });
  await assert.rejects(() => auth.authorize(ENTRY), /rejected|LOXONE_USER|password/i);
});

test('refresh() posts a refresh_token grant', async () => {
  const fetchImpl = mockFetch((u) => (u.includes('/mcp/oauth/token') ? resp({ body: JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }) }) : null));
  const auth = new LoxoneAuth({ username: 'mcp', password: 'pw', fetchImpl, log: silent });
  const t = await auth.refresh(ENTRY, { clientId: 'CID', refreshToken: 'RT', resource: 'https://relay.example/mcp' });
  assert.equal(t.accessToken, 'A2');
  assert.match(fetchImpl.calls[0].options.body.toString(), /grant_type=refresh_token/);
});

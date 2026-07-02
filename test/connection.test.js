import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, TimeoutError, readSSE, backoff } from '../src/connection.js';
import { resp } from './helpers.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };
const resolverStub = () => ({ resolve: async () => 'https://entry.x:1', invalidate() {} });
const nullCache = () => ({ load: () => null, save() {} });

function token(overrides = {}) {
  return {
    entryOrigin: 'https://entry.x:1', resource: 'https://relay.x/mcp', clientId: 'CID',
    accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, ...overrides,
  };
}

test('ensureAuth reuses a valid cached token (no auth call)', async () => {
  const cache = { load: () => token(), save() {} };
  let authorized = false;
  const auth = { fetch: async () => {}, authorize: async () => { authorized = true; return token(); }, refresh: async () => { throw new Error('nope'); } };
  const c = new Connection({ resolver: resolverStub(), auth, cache, log: silent, fetchImpl: async () => {} });
  await c.ensureAuth();
  assert.equal(authorized, false);
  assert.equal(c.state.accessToken, 'AT');
});

test('ensureAuth refreshes an expired token', async () => {
  const cache = { load: () => token({ expiresAt: Date.now() - 1000 }), save() {} };
  let refreshed = false;
  const auth = {
    fetch: async () => {},
    authorize: async () => { throw new Error('should not full-auth'); },
    refresh: async () => { refreshed = true; return { accessToken: 'AT2', refreshToken: 'RT2', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000 }; },
  };
  const c = new Connection({ resolver: resolverStub(), auth, cache, log: silent, fetchImpl: async () => {} });
  await c.ensureAuth();
  assert.equal(refreshed, true);
  assert.equal(c.state.accessToken, 'AT2');
});

test('ensureAuth falls back to full auth when refresh fails', async () => {
  const cache = { load: () => token({ expiresAt: Date.now() - 1000 }), save() {} };
  const auth = { fetch: async () => {}, authorize: async () => token({ accessToken: 'FRESH' }), refresh: async () => { throw new Error('refresh boom'); } };
  const c = new Connection({ resolver: resolverStub(), auth, cache, log: silent, fetchImpl: async () => {} });
  await c.ensureAuth();
  assert.equal(c.state.accessToken, 'FRESH');
});

test('send(initialize) parses SSE and captures the session id + protocol', async () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"lox"}}}\n\n';
  const fetchImpl = async () => resp({ status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'SID1' }, body: sse });
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => {} };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl });
  const msgs = await c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(msgs.length, 1);
  assert.equal(c.sessionId, 'SID1');
  assert.equal(c.protocolVersion, '2025-06-18');
});

test('send retries after a 401 by re-authenticating', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return resp({ status: 401, body: '{"error":"unauthorized"}' });
    return resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":2,"result":{}}' });
  };
  let auths = 0;
  const auth = { fetch: fetchImpl, authorize: async () => { auths++; return token({ accessToken: 'AT' + auths }); }, refresh: async () => { throw new Error('no refresh'); } };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl });
  c.state = token();
  const msgs = await c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(msgs[0].id, 2);
  assert.ok(calls >= 2 && auths >= 1);
});

test('send re-resolves on a network error', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNREFUSED');
    return resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":3,"result":{}}' });
  };
  let invalidated = false;
  const resolver = { resolve: async () => 'https://entry.x:1', invalidate() { invalidated = true; } };
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => { throw new Error('no'); } };
  const c = new Connection({ resolver, auth, cache: nullCache(), log: silent, fetchImpl });
  c.state = token();
  const msgs = await c.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(msgs[0].id, 3);
  assert.ok(invalidated);
});

test('readSSE parses multiple events and ignores keep-alives', async () => {
  const body = ': keep-alive\n\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
  const msgs = await readSSE(resp({ body }));
  assert.deepEqual(msgs, [{ a: 1 }, { b: 2 }]);
});

test('readSSE handles CRLF line endings and multi-line data', async () => {
  const body = 'event: message\r\ndata: {"a":1}\r\n\r\ndata: {"b":\r\ndata: 2}\r\n\r\n';
  const msgs = await readSSE(resp({ body }));
  assert.deepEqual(msgs, [{ a: 1 }, { b: 2 }]);
});

test('send replays initialize when the session was lost', async () => {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    const b = JSON.parse(opts.body);
    posts.push(b.method);
    if (b.method === 'initialize') return resp({ status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'NEWSID' }, body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
    return resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":9,"result":{}}' });
  };
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => {} };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl });
  c.state = token();
  c.initMessage = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  c.sessionId = null;
  const msgs = await c.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  assert.ok(posts.includes('initialize'));
  assert.equal(c.sessionId, 'NEWSID');
  assert.equal(msgs[0].id, 9);
});

test('a timed-out request is NOT retried (no double execution) but heals the connection', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  };
  let resolved = 0;
  const resolver = { resolve: async () => { resolved++; return 'https://entry.x:1'; }, invalidate() {} };
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => { throw new Error('no'); } };
  const c = new Connection({ resolver, auth, cache: nullCache(), log: silent, fetchImpl, requestTimeoutMs: 5 });
  c.state = token();
  await assert.rejects(() => c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call' }), TimeoutError);
  assert.equal(calls, 1, 'timed-out call must not be re-sent');
  assert.ok(resolved >= 1, 'relay should be re-resolved for subsequent requests');
});

test('a body-read failure is classified as a network error and recovered', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      const r = resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
      r.json = async () => { throw new Error('socket hang up mid-body'); };
      return r;
    }
    return resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":5,"result":{}}' });
  };
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => { throw new Error('no'); } };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl });
  c.state = token();
  const msgs = await c.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(msgs[0].id, 5);
  assert.equal(calls, 2);
});

test('404 without a session is treated as a stale relay, not a fatal error', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return resp({ status: 404, body: 'not found' });
    return resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":6,"result":{}}' });
  };
  const auth = { fetch: fetchImpl, authorize: async () => token(), refresh: async () => { throw new Error('no'); } };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl });
  c.state = token();
  const msgs = await c.send({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  assert.equal(msgs[0].id, 6);
});

test('a non-retryable auth failure (wrong credentials) is not retried', async () => {
  let attempts = 0;
  const auth = {
    fetch: async () => {},
    authorize: async () => {
      attempts++;
      const e = new Error('login was rejected');
      e.retryable = false;
      throw e;
    },
    refresh: async () => { throw new Error('no'); },
  };
  const c = new Connection({ resolver: resolverStub(), auth, cache: nullCache(), log: silent, fetchImpl: async () => {}, maxAuthAttempts: 6 });
  await assert.rejects(() => c.ensureAuth(), /login was rejected/);
  assert.equal(attempts, 1, 'must not hammer the login with bad credentials');
});

test('backoff grows and is capped at 8s', () => {
  assert.ok(backoff(1) <= backoff(2));
  assert.ok(backoff(20) <= 8000);
});

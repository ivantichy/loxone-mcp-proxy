import test from 'node:test';
import assert from 'node:assert/strict';
import { EndpointResolver, ResolveError } from '../src/resolver.js';
import { mockFetch, resp } from './helpers.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };
const base = { serial: 'ABC', minIntervalMs: 0, log: silent };

test('resolve returns the redirect origin', async () => {
  const fetchImpl = mockFetch(() => resp({ status: 307, headers: { location: 'https://1-2-3-4.abc.dyndns.loxonecloud.com:555/mcp' } }));
  const r = new EndpointResolver({ ...base, fetchImpl });
  assert.equal(await r.resolve(), 'https://1-2-3-4.abc.dyndns.loxonecloud.com:555');
});

test('resolve caches, force re-fetches, invalidate clears', async () => {
  let n = 0;
  const fetchImpl = mockFetch(() => { n++; return resp({ status: 307, headers: { location: `https://h${n}.x:1/mcp` } }); });
  const r = new EndpointResolver({ ...base, fetchImpl });
  assert.equal(await r.resolve(), 'https://h1.x:1');
  assert.equal(await r.resolve(), 'https://h1.x:1');
  assert.equal(n, 1);
  assert.equal(await r.resolve({ force: true }), 'https://h2.x:1');
  assert.equal(n, 2);
  r.invalidate();
  await r.resolve();
  assert.equal(n, 3);
});

test('resolve throws a retryable ResolveError on 429', async () => {
  const fetchImpl = mockFetch(() => resp({ status: 429, headers: { 'x-ratelimit-reset': '123' } }));
  const r = new EndpointResolver({ ...base, fetchImpl });
  await assert.rejects(() => r.resolve(), (e) => e instanceof ResolveError && e.retryable === true && e.resetEpoch === 123);
});

test('resolve throws when there is no redirect', async () => {
  const fetchImpl = mockFetch(() => resp({ status: 200, body: 'nope' }));
  const r = new EndpointResolver({ ...base, fetchImpl });
  await assert.rejects(() => r.resolve(), ResolveError);
});

test('a failed connect request is reported as retryable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = new EndpointResolver({ ...base, fetchImpl });
  await assert.rejects(() => r.resolve(), (e) => e instanceof ResolveError && e.retryable === true);
});

test('connectUrl builds the stable connect path (trailing slash tolerated)', () => {
  const r = new EndpointResolver({ serial: 'XYZ', connectBase: 'https://connect.loxonecloud.com/', fetchImpl: () => {}, log: silent });
  assert.equal(r.connectUrl, 'https://connect.loxonecloud.com/XYZ/mcp');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { StdioProxy } from '../src/proxy.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };

/** Build a proxy around a stubbed Connection; capture stdout lines. */
function makeProxy(sendImpl) {
  const written = [];
  const proxy = new StdioProxy({
    connection: { send: sendImpl },
    log: silent,
    input: null, // start() is not called in these tests
    output: { write: (s) => { written.push(s); return true; } },
  });
  const lines = () => written.filter((s) => s.trim()).map((s) => JSON.parse(s));
  return { proxy, lines };
}

test('forwards a request and writes every remote response as one line each', async () => {
  const { proxy, lines } = makeProxy(async () => [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
  ]);
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.deepEqual(lines(), [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
  ]);
});

test('synthesizes an error when the remote returns no response for a request', async () => {
  const { proxy, lines } = makeProxy(async () => []);
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' }));
  const out = lines();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 7);
  assert.equal(out[0].error.code, -32001);
});

test('a notification producing no response writes nothing', async () => {
  const { proxy, lines } = makeProxy(async () => []);
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.deepEqual(lines(), []);
});

test('a failed send answers a request with a JSON-RPC error (same id)', async () => {
  const { proxy, lines } = makeProxy(async () => { throw new Error('relay died'); });
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'tools/call' }));
  const out = lines();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'abc');
  assert.match(out[0].error.message, /relay died/);
});

test('a failed send for a notification writes nothing', async () => {
  const { proxy, lines } = makeProxy(async () => { throw new Error('boom'); });
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.deepEqual(lines(), []);
});

test('a non-JSON input line is dropped without output', async () => {
  let sent = 0;
  const { proxy, lines } = makeProxy(async () => { sent++; return []; });
  await proxy._handle('this is not json');
  assert.equal(sent, 0);
  assert.deepEqual(lines(), []);
});

test('id 0 is treated as a request (falsy but valid JSON-RPC id)', async () => {
  const { proxy, lines } = makeProxy(async () => { throw new Error('x'); });
  await proxy._handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }));
  assert.equal(lines()[0].id, 0);
});

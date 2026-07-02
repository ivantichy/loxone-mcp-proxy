import test from 'node:test';
import assert from 'node:assert/strict';
import { StateWarmer } from '../src/stateWarmer.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };

function toolResult(id, payload) {
  return [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }];
}

function stubConnection(controls) {
  const calls = [];
  return {
    sessionId: 'SID',
    calls,
    async send(msg) {
      calls.push(msg);
      const { name } = msg.params;
      if (name === 'control_find') {
        return toolResult(msg.id, { matches: controls, total: controls.length, truncated: false });
      }
      if (name === 'control_state') return toolResult(msg.id, { count: 0, states: [] });
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

const CONTROLS = [
  { name: 'Obývák', uuid: 'U1' },
  { name: 'Kuchyně', uuid: 'U2' },
  { name: 'Kuchyně dup', uuid: 'U2' }, // duplicate uuid must be touched once
  { name: 'Circuit', uuid: 'U3/1', parent_uuid: 'U3' }, // subcontrol — skipped
];

test('default warm-up is a single control_state nudge', async () => {
  const conn = stubConnection(CONTROLS);
  const w = new StateWarmer({ connection: conn, log: silent, delayMs: 0, spacingMs: 0 });
  await w._run(++w._generation);
  assert.equal(conn.calls.length, 1);
  assert.equal(conn.calls[0].params.name, 'control_state');
  assert.deepEqual(conn.calls[0].params.arguments, { limit: 1 });
});

test('sweepAll additionally touches each top-level uuid once, with namespaced ids', async () => {
  const conn = stubConnection(CONTROLS);
  const w = new StateWarmer({ connection: conn, log: silent, delayMs: 0, spacingMs: 0, sweepAll: true });
  await w._run(++w._generation);
  const stateCalls = conn.calls.filter((m) => m.params.name === 'control_state');
  assert.deepEqual(stateCalls.map((m) => m.params.arguments.uuid), [undefined, 'U1', 'U2']); // nudge + sweep
  // background ids must be namespaced strings, never numeric like Claude's
  for (const m of conn.calls) assert.match(String(m.id), /^warmup-/);
});

test('sweep aborts when the session is gone', async () => {
  const conn = stubConnection(CONTROLS);
  const w = new StateWarmer({ connection: conn, log: silent, delayMs: 0, spacingMs: 0, sweepAll: true });
  const origSend = conn.send.bind(conn);
  conn.send = async (msg) => {
    const r = await origSend(msg);
    if (msg.params.name === 'control_find') conn.sessionId = null; // dies after enumeration
    return r;
  };
  await w._run(++w._generation);
  assert.equal(conn.calls.filter((m) => m.params.arguments?.uuid).length, 0, 'no per-uuid touches after session loss');
});

test('a newer generation supersedes a running sweep', async () => {
  const conn = stubConnection(CONTROLS);
  const w = new StateWarmer({ connection: conn, log: silent, delayMs: 0, spacingMs: 0, sweepAll: true });
  const gen = ++w._generation;
  const origSend = conn.send.bind(conn);
  conn.send = async (msg) => {
    const r = await origSend(msg);
    if (msg.params.arguments?.uuid) w._generation++; // new session arrived mid-sweep
    return r;
  };
  await w._run(gen);
  assert.equal(conn.calls.filter((m) => m.params.arguments?.uuid).length, 1);
});

test('a failing nudge rejects _run but schedule() swallows it (fire-and-forget)', async () => {
  const conn = {
    sessionId: 'SID',
    async send(msg) {
      return [{ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }];
    },
  };
  const w = new StateWarmer({ connection: conn, log: silent, delayMs: 0, spacingMs: 0 });
  await assert.rejects(() => w._run(++w._generation), /control_state/);
  w.schedule();
  await new Promise((r) => setTimeout(r, 10)); // must not throw/unhandled-reject
});

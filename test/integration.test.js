// Live integration test — hits the real Miniserver via Loxone Cloud.
// Skipped unless LOXONE_INTEGRATION=1 and a valid .env are present.
//   LOXONE_INTEGRATION=1 npm run test:integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { EndpointResolver } from '../src/resolver.js';
import { LoxoneAuth } from '../src/loxoneAuth.js';
import { Connection } from '../src/connection.js';
import { NullCache } from '../src/cache.js';

const RUN = process.env.LOXONE_INTEGRATION === '1';
const skip = RUN ? false : 'set LOXONE_INTEGRATION=1 and provide .env to run';

test('headless login + initialize + tools/list against the real Miniserver', { skip }, async () => {
  const cfg = loadConfig();
  const resolver = new EndpointResolver({ serial: cfg.serial, connectBase: cfg.connectBase, minIntervalMs: cfg.connectMinIntervalMs });
  const auth = new LoxoneAuth({ username: cfg.username, password: cfg.password, redirectPort: cfg.redirectPort });
  const conn = new Connection({ resolver, auth, cache: new NullCache(), maxAuthAttempts: cfg.maxResolveAttempts });

  const init = await conn.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } });
  assert.ok(init.find((m) => m.result)?.result?.serverInfo, 'should receive serverInfo');

  await conn.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tl = await conn.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = tl.find((m) => m.result)?.result?.tools || [];
  assert.ok(tools.length > 0, 'should list at least one tool');
});

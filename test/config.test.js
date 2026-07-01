import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv, loadConfig } from '../src/config.js';

test('loadDotEnv parses KEY=VALUE + quotes and never overrides existing env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lox-env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, '# comment\nFOO=bar\nQUOTED="hello world"\nSINGLE=\'x\'\nPRESET=override\n');
  delete process.env.FOO; delete process.env.QUOTED; delete process.env.SINGLE;
  process.env.PRESET = 'keep';
  const loaded = loadDotEnv(f);
  assert.equal(loaded, f);
  assert.equal(process.env.FOO, 'bar');
  assert.equal(process.env.QUOTED, 'hello world');
  assert.equal(process.env.SINGLE, 'x');
  assert.equal(process.env.PRESET, 'keep');
});

test('loadConfig throws listing all missing required fields', () => {
  const save = { ...process.env };
  process.env.LOXONE_NO_DOTENV = '1';
  for (const k of ['LOXONE_SERIAL', 'LOXONE_USER', 'LOXONE_USERNAME', 'LOXONE_PASSWORD', 'LOXONE_PASS']) delete process.env[k];
  assert.throws(() => loadConfig(), /Missing required config.*LOXONE_SERIAL.*LOXONE_USER.*LOXONE_PASSWORD/s);
  process.env = save;
});

test('loadConfig normalizes the serial and reads credentials', () => {
  const save = { ...process.env };
  process.env.LOXONE_NO_DOTENV = '1';
  process.env.LOXONE_SERIAL = '50:4f:94:a1:ae:7a';
  process.env.LOXONE_USER = 'mcp';
  process.env.LOXONE_PASSWORD = 'pw';
  const cfg = loadConfig();
  assert.equal(cfg.serial, '504F94A1AE7A');
  assert.equal(cfg.username, 'mcp');
  assert.equal(cfg.password, 'pw');
  assert.equal(cfg.connectBase, 'https://connect.loxonecloud.com');
  process.env = save;
});

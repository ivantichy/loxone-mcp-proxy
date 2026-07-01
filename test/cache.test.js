import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenCache, NullCache } from '../src/cache.js';

test('TokenCache round-trips data and creates parent dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lox-cache-'));
  const file = path.join(dir, 'nested', 'cache.json');
  const cache = new TokenCache(file);
  assert.equal(cache.load(), null);
  cache.save({ accessToken: 'AT', resource: 'https://r/mcp' });
  assert.deepEqual(cache.load(), { accessToken: 'AT', resource: 'https://r/mcp' });
  cache.clear();
  assert.equal(cache.load(), null);
});

test('TokenCache tolerates corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lox-cache-'));
  const file = path.join(dir, 'cache.json');
  fs.writeFileSync(file, 'not json');
  const cache = new TokenCache(file, { warn() {} });
  assert.equal(cache.load(), null);
});

test('NullCache is a no-op', () => {
  const c = new NullCache();
  c.save({ a: 1 });
  assert.equal(c.load(), null);
});

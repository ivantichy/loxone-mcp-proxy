#!/usr/bin/env node
// Quick connectivity + credentials check. Runs the full headless login and
// lists the available Loxone tools, WITHOUT starting the stdio proxy.
// Usage:  npm run login-check
import { loadConfig } from '../src/config.js';
import { EndpointResolver } from '../src/resolver.js';
import { LoxoneAuth } from '../src/loxoneAuth.js';
import { Connection } from '../src/connection.js';
import { NullCache } from '../src/cache.js';

function out(...a) { process.stdout.write(a.join(' ') + '\n'); }

let config;
try {
  config = loadConfig();
} catch (e) {
  process.stderr.write(`Configuration error: ${e.message}\n`);
  process.exit(1);
}

out(`Checking Loxone MCP for serial ${config.serial} as user "${config.username}"...`);

const resolver = new EndpointResolver({ serial: config.serial, connectBase: config.connectBase, minIntervalMs: config.connectMinIntervalMs });
const auth = new LoxoneAuth({ username: config.username, password: config.password, redirectPort: config.redirectPort });
const connection = new Connection({ resolver, auth, cache: new NullCache(), maxAuthAttempts: config.maxResolveAttempts });

try {
  const init = await connection.send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loxone-mcp-proxy login-check', version: '0.1.0' } },
  });
  const server = init.find((m) => m.result)?.result?.serverInfo;
  out(`OK  Authenticated & connected.${server ? `  Server: ${server.name} ${server.version || ''}` : ''}`);

  await connection.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tl = await connection.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = tl.find((m) => m.result)?.result?.tools || [];
  out(`OK  ${tools.length} tools available: ${tools.map((t) => t.name).join(', ') || '(none)'}`);
  out('\nAll good - this configuration works in Claude Desktop.');
  process.exit(0);
} catch (e) {
  process.stderr.write(`FAILED: ${e.message}\n`);
  process.exit(1);
}

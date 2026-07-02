#!/usr/bin/env node
import { loadConfig } from './config.js';
import logger from './logger.js';
import { EndpointResolver } from './resolver.js';
import { LoxoneAuth } from './loxoneAuth.js';
import { TokenCache } from './cache.js';
import { Connection } from './connection.js';
import { StdioProxy } from './proxy.js';

// Never let a stray rejection kill the stdio pipe silently.
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => logger.error('uncaughtException:', e));

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    logger.error(e.message);
    process.exit(1);
  }

  logger.info(`loxone-mcp-proxy starting — serial ${config.serial}, user "${config.username}"`);

  const resolver = new EndpointResolver({
    serial: config.serial,
    connectBase: config.connectBase,
    minIntervalMs: config.connectMinIntervalMs,
  });
  const auth = new LoxoneAuth({
    username: config.username,
    password: config.password,
    redirectPort: config.redirectPort,
  });
  const cache = new TokenCache(config.cachePath);
  const connection = new Connection({
    resolver, auth, cache,
    maxAuthAttempts: config.maxResolveAttempts,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  const proxy = new StdioProxy({ connection });
  proxy.start();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.info(`received ${sig}, exiting`);
      process.exit(0);
    });
  }

  // Warm up auth so the first Claude request is fast. Failures are non-fatal —
  // the connection retries on demand.
  connection.ensureAuth().catch((e) => logger.warn('startup auth warmup failed (will retry on first request):', e.message));
}

main().catch((e) => {
  logger.error('fatal:', e);
  process.exit(1);
});

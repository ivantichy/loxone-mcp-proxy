#!/usr/bin/env node
import { loadConfig } from './config.js';
import logger from './logger.js';
import { EndpointResolver } from './resolver.js';
import { LoxoneAuth } from './loxoneAuth.js';
import { TokenCache } from './cache.js';
import { Connection } from './connection.js';
import { StateWarmer } from './stateWarmer.js';
import { StdioProxy } from './proxy.js';

// A stray rejection is logged but tolerated — background retries may reject
// after their request already failed over, and killing the pipe for that
// would drop a healthy session. An uncaught synchronous exception is
// different: internal state may be arbitrarily corrupt, so log it loudly and
// exit non-zero — Claude Desktop restarts the server and gets a clean state.
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException (exiting):', e);
  process.exit(1);
});

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

  if (config.stateWarmup) {
    const warmer = new StateWarmer({
      connection,
      delayMs: config.warmupDelayMs,
      spacingMs: config.warmupSpacingMs,
      maxControls: config.warmupMaxControls,
      sweepAll: config.warmupSweepAll,
    });
    connection.onSessionEstablished = () => warmer.schedule();
    logger.info(`state warm-up enabled (${config.warmupSweepAll ? 'nudge + full sweep' : 'nudge'} after each (re-)initialize)`);
  }

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

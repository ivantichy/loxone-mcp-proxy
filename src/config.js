import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Minimal .env loader (no dependency). Existing process.env values win, so
 * real environment variables always override the file.
 * Returns the path of the file that was loaded, or null.
 */
export function loadDotEnv(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.LOXONE_ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(PROJECT_ROOT, '.env'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let [, key, val] = m;
        val = val.trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
      return p;
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}

function bool(raw) {
  return raw === '1' || /^true$/i.test(raw || '');
}

/** Parse an integer env var, failing loudly instead of propagating NaN. */
function intEnv(name, fallback, { min = 1, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max === Infinity ? '…' : max}] (got "${raw}")`);
  }
  return n;
}

/** Load and validate configuration from environment (+ .env). */
export function loadConfig() {
  const envFile = process.env.LOXONE_NO_DOTENV ? null : loadDotEnv();

  const serial = (process.env.LOXONE_SERIAL || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const username = process.env.LOXONE_USER || process.env.LOXONE_USERNAME || '';
  const password = process.env.LOXONE_PASSWORD || process.env.LOXONE_PASS || '';

  const missing = [];
  if (!serial) missing.push('LOXONE_SERIAL');
  if (!username) missing.push('LOXONE_USER');
  if (!password) missing.push('LOXONE_PASSWORD');
  if (missing.length) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. ` +
      `Set them in a .env file or the environment. Loaded env file: ${envFile || 'none'}`
    );
  }

  return {
    serial,
    username,
    password,
    connectBase: (process.env.LOXONE_CONNECT_BASE || 'https://connect.loxonecloud.com').replace(/\/+$/, ''),
    cachePath: process.env.LOXONE_CACHE_PATH || path.join(os.homedir(), '.loxone-mcp-proxy', 'cache.json'),
    redirectPort: intEnv('LOXONE_REDIRECT_PORT', 41678, { min: 1, max: 65535 }),
    maxResolveAttempts: intEnv('LOXONE_MAX_ATTEMPTS', 6),
    connectMinIntervalMs: intEnv('LOXONE_CONNECT_MIN_INTERVAL_MS', 2000, { min: 0 }),
    requestTimeoutMs: intEnv('LOXONE_REQUEST_TIMEOUT_MS', 120_000, { min: 1000 }),
    stateWarmup: bool(process.env.LOXONE_STATE_WARMUP),
    warmupSweepAll: bool(process.env.LOXONE_WARMUP_SWEEP),
    warmupDelayMs: intEnv('LOXONE_WARMUP_DELAY_MS', 1000, { min: 0 }),
    warmupSpacingMs: intEnv('LOXONE_WARMUP_SPACING_MS', 150, { min: 0 }),
    warmupMaxControls: intEnv('LOXONE_WARMUP_MAX_CONTROLS', 500),
    envFile,
  };
}

export { PROJECT_ROOT };

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
    redirectPort: parseInt(process.env.LOXONE_REDIRECT_PORT || '41678', 10),
    maxResolveAttempts: parseInt(process.env.LOXONE_MAX_ATTEMPTS || '6', 10),
    connectMinIntervalMs: parseInt(process.env.LOXONE_CONNECT_MIN_INTERVAL_MS || '2000', 10),
    envFile,
  };
}

export { PROJECT_ROOT };

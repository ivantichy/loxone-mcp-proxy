import fs from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

/**
 * Tiny JSON token cache on disk. Stores the OAuth state so a restart doesn't
 * always need a fresh login. The file is written 0600 and its directory 0700
 * since it holds bearer/refresh tokens.
 */
export class TokenCache {
  constructor(filePath, log = logger) {
    this.filePath = filePath;
    this.log = log;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {
      this.log.warn('cache: failed to read cache:', e.message);
    }
    return null;
  }

  save(data) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Write-then-rename so a crash mid-write can't leave a corrupt cache
      // (a corrupt cache silently costs a full re-login on next start).
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      this.log.warn('cache: failed to write cache:', e.message);
    }
  }

  clear() {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** A no-op cache (used in tests or when caching is disabled). */
export class NullCache {
  load() { return null; }
  save() {}
  clear() {}
}

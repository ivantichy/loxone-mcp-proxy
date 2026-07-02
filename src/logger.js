// Structured logger. CRITICAL: everything goes to stderr, because stdout is
// reserved for the MCP stdio JSON-RPC stream that Claude Desktop reads.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentThreshold() {
  const debug = process.env.LOXONE_DEBUG;
  if (debug === '1' || /^true$/i.test(debug || '')) return LEVELS.debug;
  const lvl = (process.env.LOXONE_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[lvl] ?? LEVELS.info;
}

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  // JSON.stringify(undefined) returns undefined, which would blank the line
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
}

function emit(level, args) {
  if (LEVELS[level] > currentThreshold()) return;
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [loxone-mcp ${level}] ${args.map(fmt).join(' ')}\n`);
}

export const logger = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};

export default logger;

import readline from 'node:readline';
import logger from './logger.js';

/**
 * Bridges Claude Desktop's stdio MCP transport to the remote Loxone MCP
 * endpoint. Reads newline-delimited JSON-RPC from stdin, forwards each message
 * through the Connection, and writes responses back to stdout.
 *
 * stdout carries ONLY protocol JSON — all diagnostics go to stderr (logger).
 */
export class StdioProxy {
  constructor({ connection, log = logger, input = process.stdin, output = process.stdout }) {
    this.connection = connection;
    this.log = log;
    this.input = input;
    this.output = output;
    // Serialize handling so concurrent auth/refresh can't race.
    this.queue = Promise.resolve();
  }

  start() {
    const rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) this._enqueue(trimmed);
    });
    rl.on('close', async () => {
      this.log.info('proxy: stdin closed, draining and shutting down');
      // Readline can emit a final line right before 'close'; finish the queue,
      // then let stdout flush — pipe writes are asynchronous on Windows and a
      // bare process.exit() would truncate an in-flight response.
      try { await this.queue; } catch { /* handler errors are already logged */ }
      this.output.write('', () => process.exit(0));
    });
    this.log.info('proxy: ready (Claude stdio <-> Loxone MCP)');
  }

  _enqueue(line) {
    this.queue = this.queue.then(() => this._handle(line)).catch((e) => this.log.error('proxy: handler error:', e));
  }

  async _handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn('proxy: dropping non-JSON input line');
      return;
    }
    try {
      const responses = await this.connection.send(msg);
      for (const r of responses) this._write(r);
      // A request must produce a response; if the remote answered with nothing
      // (e.g. a bare 202), synthesize an error so Claude doesn't hang forever.
      if (isRequest(msg) && !responses.some((r) => r && r.id === msg.id)) {
        this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'loxone-mcp-proxy: remote returned no response for this request' } });
      }
    } catch (e) {
      this.log.error(`proxy: send failed for "${msg.method || '?'}": ${e.message}`);
      // Only requests (with an id) expect a reply; answer with a JSON-RPC error
      // so Claude doesn't hang waiting.
      if (isRequest(msg)) {
        this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: `loxone-mcp-proxy: ${e.message}` } });
      }
    }
  }

  _write(obj) {
    try {
      this.output.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      this.log.warn('proxy: stdout write failed:', e.message);
    }
  }
}

function isRequest(m) {
  return !!m && m.id !== undefined && m.id !== null;
}

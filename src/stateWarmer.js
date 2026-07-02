import logger from './logger.js';

/**
 * Opt-in warm-up for the Miniserver's MCP state table (tech preview).
 *
 * The native MCP server fills its `control_state` table only from state-change
 * deltas, and it starts collecting them with the FIRST state query of a
 * "table epoch" (the table is wiped when the server-side MCP process winds
 * down, e.g. after all sessions drop). Verified live 2026-07-02: a delta that
 * arrived after one control was queried showed up for *all* controls,
 * including ones never queried — the subscription pool is global, not
 * per-control. There is no initial snapshot, so without a warm-up the table
 * only starts filling when the user happens to ask the first question, and
 * that first answer is empty ("what's the temperature?" → no data).
 *
 * The fix is correspondingly small: after every established session — the
 * client's `initialize` as well as every transparent re-initialize after a
 * session loss — issue one tiny `control_state` nudge so delta collection
 * runs from second zero. Values then accumulate while the assistant idles
 * and are present by the time the user asks.
 *
 * `sweepAll` additionally touches every control individually (belt and
 * braces in case a future firmware scopes subscriptions per control). Off by
 * default — it is redundant under the currently observed semantics.
 */
export class StateWarmer {
  constructor({ connection, log = logger, delayMs = 1000, spacingMs = 150, maxControls = 500, sweepAll = false }) {
    this.connection = connection;
    this.log = log;
    this.delayMs = delayMs;
    this.spacingMs = spacingMs;
    this.maxControls = maxControls;
    this.sweepAll = sweepAll;
    this._generation = 0;
    this._nextId = 1;
  }

  /** Schedule a warm-up. Any run still in flight is superseded. */
  schedule() {
    const gen = ++this._generation;
    setTimeout(() => {
      this._run(gen).catch((e) => this.log.warn('warmup: failed (will retry on next session):', e.message));
    }, this.delayMs).unref?.();
  }

  async _run(gen) {
    // The nudge: one minimal state query starts the server's global delta
    // collection for this table epoch.
    await this._call('control_state', { limit: 1 });
    this.log.info('warmup: state-delta collection nudged; values accumulate from now on');
    if (this.sweepAll) await this._sweep(gen);
  }

  async _sweep(gen) {
    const controls = await this._listControls();
    this.log.info(`warmup: sweeping ${controls.length} controls`);
    for (const uuid of controls) {
      // A newer warm-up (session re-established) or a lost session obsoletes this one.
      if (gen !== this._generation) return;
      if (!this.connection.sessionId) {
        this.log.debug('warmup: session gone, aborting sweep');
        return;
      }
      await this._call('control_state', { uuid, limit: 1 });
      await sleep(this.spacingMs);
    }
    this.log.info('warmup: sweep done');
  }

  async _listControls() {
    const result = await this._call('control_find', { query: '', limit: this.maxControls });
    const matches = result?.matches || [];
    // Subcontrols share their parent's states — warming the parent covers them.
    const uuids = [...new Set(matches.filter((m) => !m.parent_uuid).map((m) => m.uuid))];
    if (result?.truncated) this.log.warn(`warmup: control list truncated at ${this.maxControls}; raise LOXONE_WARMUP_MAX_CONTROLS to cover everything`);
    return uuids;
  }

  /** One background tools/call. Ids are namespaced strings so they can never
   *  collide with the numeric ids Claude uses on the shared session. */
  async _call(name, args) {
    const msg = {
      jsonrpc: '2.0',
      id: `warmup-${this._nextId++}`,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const responses = await this.connection.send(msg);
    const resp = responses.find((r) => r && r.id === msg.id);
    if (!resp || resp.error || resp.result?.isError) {
      throw new Error(`${name}: ${resp?.error ? JSON.stringify(resp.error) : 'error result'}`);
    }
    const text = (resp.result?.content || []).find((c) => c.type === 'text')?.text;
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null; // tolerable — warming works by the query itself, not the payload
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

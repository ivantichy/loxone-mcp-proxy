# Independent Code Review — loxone-mcp-proxy

**Date:** 2026-07-02 · **Reviewed revision:** `6a89ee8` (main) · **Fix branch:** `review/2026-07`
**Method:** full manual read of every source/test file; a 50-agent multi-dimension review
(stdio pipe, connection lifecycle, security, error handling, auth flow, architecture/docs)
with adversarial verification of every finding (37 confirmed, 7 refuted); unit test run;
live end-to-end smoke test of the fix branch against the real Miniserver
(initialize → tools/list → control_state).

File:line references below point at the **reviewed revision `6a89ee8`**, not at the fix branch.

---

## Overall verdict

**Yes — this is written well.** The architecture is exactly right for the job: five small
single-purpose modules with clean constructor injection, zero dependencies as promised, stdout
strictly reserved for protocol traffic, secrets kept out of logs (verified — no token, password,
or authorization code reaches any log or error string), and a sensible self-healing model
(re-resolve → refresh → re-login → re-init) that the unit tests actually exercise. The README is
unusually honest and the `resource`-vs-entry-origin discovery is documented where it matters.

The weaknesses were concentrated in two areas, both now addressed on the fix branch:
**unbounded remote I/O** (no timeout anywhere; one hung relay request would wedge the serialized
pipe forever) and a handful of **lifecycle races/edge cases** (auth warmup racing the first
request, refresh-token clobbering, credential-rejection retry storm). Nothing critical was found;
no secret-handling defect was found.

## Test results

| Suite | Result |
|---|---|
| Unit tests @ `6a89ee8` | **28/28 pass** (+1 integration test skipped) |
| Unit tests @ `review/2026-07` | **44/44 pass** (+1 skipped) |
| Integration test (`LOXONE_INTEGRATION=1`) | **Not run** — touches the live Miniserver; needs owner approval |
| Live smoke test of fix branch | **Pass** — initialize / tools/list (11 tools) / control_state over stdio |

⚠️ **Local environment note:** `npm test` on this machine reports every test *file* as failed even
though every individual test passes. The locally installed **Node v25.9.0 segfaults on process
exit** (reproducible with plain `node -e "0"`), which `node --test` counts as a file failure, and
which also makes the proxy exit non-zero on shutdown. This is not a project bug. Recommendation:
run on **Node 22 LTS**.

---

## Findings

Severities: **critical** = breaks core function or leaks secrets · **major** = real failure mode in
plausible operation · **minor** = robustness/docs/readability.

### Critical

None.

### Major

| # | Location | Finding | Status |
|---|---|---|---|
| M1 | `src/connection.js:166`, `:218` | **No timeout on any fetch or on the SSE read loop.** A relay that accepts the connection but never completes the response — or holds the SSE stream open with keep-alive comments, which reset undici's per-chunk `bodyTimeout` forever — hangs `send()` permanently. Because the proxy serializes all stdio traffic (see M2), one such request blocks *everything*, including pings; Claude Desktop sees a dead server until restart. | **Fixed** `668f123` — `AbortSignal.timeout` (default 120 s, `LOXONE_REQUEST_TIMEOUT_MS`); timeouts are deliberately **not retried** (the remote may still execute the command — a blind retry could run `control_command` twice) but heal the connection for the next request. |
| M2 | `src/proxy.js:18`, `:35` | **Head-of-line blocking.** Every inbound message chains onto one promise queue, so a slow `tools/call` delays everything behind it; `notifications/cancelled` can by construction only arrive *after* the call it should cancel; pings queue behind connection-level retry backoffs. | **Open** (design change — see Recommendations). Impact is now bounded by the M1 timeout; previously it was potentially infinite. |
| M3 | `src/connection.js:187–191` | **Mid-stream failures bypass recovery.** `readSSE()`/`res.json()` run outside the try/catch that classifies `NetworkError`, so a connection reset *while reading the body* skipped the re-resolve recovery path and failed the request outright — the exact failure mode of a relay dying mid-response. | **Fixed** `668f123` |
| M4 | `src/index.js:12` | **`uncaughtException` logged and resumed.** After an uncaught synchronous throw, internal state may be arbitrarily corrupt, yet the process kept driving home automation. Claude Desktop restarts crashed MCP servers, so exiting is the safe recovery. (`unhandledRejection` staying log-only is reasonable and is now documented inline.) | **Fixed** `4d7cd46` |
| M5 | `src/connection.js:85–101` + `src/loxoneAuth.js:136` | **Wrong credentials retried 6×.** A definitive login rejection (form re-rendered / `access_denied`) was retried like a transient failure — hammering the Miniserver login and risking a lockout of the dedicated Loxone user. | **Fixed** `7338308` — `AuthError.retryable=false` aborts the retry loop. |

### Minor — fixed on `review/2026-07`

| Location | Finding | Commit |
|---|---|---|
| `src/connection.js:72` | Refresh response without a rotated `refresh_token` clobbered the stored one with `null` (state spread), silently forcing a full login next time. | `617455e` |
| `src/connection.js:62` + `src/index.js:50` | `ensureAuth` not single-flight: the startup warmup races the first request → double full login, racing registrations/state writes. | `992ce94` |
| `src/connection.js:126` | Any 401 forced a *full credential login* even when a valid refresh token was held (force skips the refresh path). Now: first 401 → refresh; repeated 401 → full login. | `668f123` |
| `src/connection.js:173` | 404 **without** a session (stale cached `entryOrigin` after restart) was a fatal remote error instead of triggering re-resolution. | `668f123` |
| `src/connection.js:223` | `readSSE` only recognized `\n\n` event boundaries; a CRLF SSE stream (allowed by the spec) collapsed into one unparseable event. | `ec32fc5` |
| `src/proxy.js:47` | A request whose remote reply contained no matching response (e.g. bare 202) produced *nothing* — the client hangs forever. Now synthesizes a JSON-RPC error. | `f548973` |
| `src/proxy.js:29` | `process.exit(0)` on stdin close raced async pipe writes (Windows) and skipped queued work — one-shot `echo req \| proxy` never got an answer. Now drains the queue and flushes stdout first. | `f548973` |
| `test/` | `StdioProxy` — the module every message passes through — had **zero tests**. Added 7 (forwarding, error answers, notification behavior, id 0, non-JSON input). | `f548973` |
| `src/resolver.js:53` | A non-HTTPS redirect target from connect would have been accepted — password + Bearer tokens over plaintext. Now refused (`retryable:false`). | `fb7ca5f` |
| `src/cache.js:30` | Token cache written non-atomically; crash mid-write corrupts it (cost: silent full re-login). Now write-then-rename. | `0569513` |
| `src/config.js:72–74` | `parseInt` results never validated — `LOXONE_REDIRECT_PORT=abc` propagated `NaN` into the redirect URI, retry counts and throttling. | `923b686` |
| `src/logger.js:16` | `fmt(undefined)` blanked the diagnostic (`JSON.stringify(undefined)` is `undefined`). | `923b686` |
| `package.json:14` | `test:integration` used POSIX `VAR=1 cmd` syntax → fails under cmd.exe on Windows, the platform this proxy is deployed on. | `6666428` |
| `README.md:197` | Config table omitted five env vars the code reads (`LOXONE_LOG_LEVEL`, `LOXONE_MAX_ATTEMPTS`, `LOXONE_CONNECT_MIN_INTERVAL_MS`, `LOXONE_ENV_FILE`, `LOXONE_NO_DOTENV`) and the new `LOXONE_REQUEST_TIMEOUT_MS`. | `6666428` |
| `README.md:170` + `src/cache.js:29` | “Tokens cached with 0600 permissions” — POSIX modes are a no-op on Windows; README now says so honestly. (NTFS ACLs on the profile dir are the actual protection.) | `6666428` |
| `src/loxoneAuth.js:205`, `sleep()` ×2 | Stale comment (“refresh a bit early” — the 60 s margin lives in `_tokenValid`); `sleep()` defined+exported in two modules. | `6666428` |

### Minor — open (recommendations, no code change made)

| Location | Finding |
|---|---|
| `src/proxy.js:17` | The remaining head-of-line design (M2). If concurrent dispatch is ever implemented, serialize only auth/session-replay inside `Connection` (mutex), not the whole pipe. |
| `src/connection.js:202` | `readSSE` buffers the entire stream before returning; server-initiated *requests* inside the same stream (rare; sampling-style) would deadlock, and progress notifications are delayed until stream end. Fine for the Loxone server today. |
| — | The proxy never opens the streamable-HTTP **GET** channel, so unsolicited server→client messages (e.g. `notifications/tools/list_changed`) can never arrive. The Loxone tech-preview server doesn't appear to use it; document or implement later. |
| `src/loxoneAuth.js:39`, `:73` | Every full login performs a **new dynamic client registration**; client_ids accumulate on the Miniserver. Consider reusing the cached `client_id` and re-registering only on rejection. |
| `src/config.js:18` | `.env` is discovered from `process.cwd()` *before* the project root — under Claude Desktop the cwd is not the repo, so a stray `.env` elsewhere could silently supply credentials. Consider project-root-first, or cwd only via explicit `LOXONE_ENV_FILE`. |
| `src/resolver.js:46` | `ResolveError.retryable`/`resetEpoch` (429) are computed but never consumed — `_fullAuth` backs off blindly; honoring `resetEpoch` would avoid hammering a rate-limited connect. Backoff has no jitter (irrelevant for a single client). |
| `src/connection.js:147–152` | `_replayInit` discards the replayed initialize result and logs a failed `notifications/initialized` only at debug level; an error result would go unnoticed until the next call fails. |
| `src/config.js:73` | Naming drift: `LOXONE_MAX_ATTEMPTS` → `maxResolveAttempts` → `maxAuthAttempts`. Pick one name. |
| `test/helpers.js` | Lives in `test/`, so `node --test` executes it as a (trivially empty) test file. Rename to `_helpers.js` or move to `test/support/` if the runner output bothers you. |

### Claimed findings that did **not** survive adversarial verification (for the record)

- *stdout backpressure unbounded buffering* — real code fact, but MCP responses are small and the client reads continuously; no plausible failure.
- *no `-32700` reply for malformed JSON lines* — a parse-error reply may not carry a usable `id` anyway; dropping+logging is a defensible choice (Claude never sends garbage).
- *OAuth `state` not verified / form action could be foreign* — the client drives the entire flow itself over TLS to the resolved origin; no additional exposure was demonstrable. Verifying `state` and pinning the form action origin would still be cheap hygiene.
- *username heuristic could clobber hidden fields matching `/user|name/i`* — true in theory, not with the real Loxone form; worth remembering if the login page ever changes.
- *JSON-RPC batch arrays unanswered* — MCP protocol 2025-06-18 removed batch support; non-issue.

---

## Top 3 recommendations

1. **Run the proxy on Node 22 LTS.** The local Node v25.9.0 segfaults on every process exit,
   which breaks `npm test` reporting (all files "fail" while all tests pass) and makes shutdowns
   exit non-zero. Everything else in this review was verified under that handicap.
2. **Remove the head-of-line bottleneck (M2)** if/when the assistant starts issuing concurrent or
   long-running calls: dispatch stdio messages concurrently and serialize only
   auth/session-replay inside `Connection`. Until then the new 120 s request timeout keeps the
   worst case bounded.
3. **Add the opt-in state-seeding middleware** (designed separately, see the 2026-07 state-cache
   diagnosis): the Miniserver's native MCP fills its state table only from deltas after
   subscribe, so fresh sessions see empty `control_state` for slow-moving states — a proxy-side
   seed after (re-)initialize is the only client-side fix available today.

// Test helpers: build fake fetch Responses (incl. SSE bodies) and a routable
// fetch mock. Kept dependency-free to match the project.

export function toStream(str) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(str));
      c.close();
    },
  });
}

/** Build a minimal Response-like object. */
export function resp({ status = 200, headers = {}, body = '' } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const v = h.get(String(k).toLowerCase());
        return v === undefined ? null : v;
      },
    },
    async json() { return JSON.parse(body); },
    async text() { return body; },
    get body() { return toStream(body); },
  };
}

/**
 * Build a fetch mock from a router: (url, options, calls) => respSpec | resp.
 * Throws if the router returns nothing (helps catch unexpected requests).
 */
export function mockFetch(router) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, options });
    const r = router(u, options, calls);
    if (!r) throw new Error(`mockFetch: no route for ${options.method || 'GET'} ${u}`);
    return r.status !== undefined && typeof r.headers?.get === 'function' ? r : resp(r);
  };
  fn.calls = calls;
  return fn;
}

/** A realistic Loxone login form (matches the real authorize page shape). */
export const LOGIN_FORM_HTML = `<!doctype html><html><head><title>loxone-mcp-proxy</title></head>
<body><form method="POST" action="">
  <input type="hidden" name="response_type" value="code">
  <input type="hidden" name="client_id" value="CID">
  <input type="hidden" name="redirect_uri" value="http://localhost:41678/callback">
  <input type="hidden" name="state" value="STATE">
  <input type="hidden" name="code_challenge" value="CH">
  <input type="hidden" name="code_challenge_method" value="S256">
  <input type="hidden" name="resource" value="https://relay.example/mcp">
  <input class="login-form__username" type="text" name="username" placeholder="User">
  <input class="login-form__password" type="password" name="password" placeholder="Password">
  <button type="submit">Allow</button>
</form></body></html>`;

# Loxone MCP Proxy

A tiny, **zero-dependency** local proxy that gives Claude Desktop (or any
stdio-based MCP client) a **stable** connection to a **Loxone Miniserver's
native MCP Server** — with a fully **headless, credential-based login** (no
browser, no manual OAuth click).

> Loxone Gen 2 Miniservers (firmware **17.1+**) can run a built-in **MCP Server**
> plugin. Connecting a *local* MCP client to it normally has two pain points that
> this proxy solves for you.

## Why this exists

1. **The Miniserver's MCP URL is not stable.** Loxone publishes the endpoint
   through a Cloud "connect" service that **redirects to a relay address that
   rotates over time** (it changes on Miniserver restarts and relay reshuffles).
   If you hard-code the redirected `…dyndns.loxonecloud.com:PORT/mcp` URL into a
   client, it breaks a while later.
2. **Auth is interactive by default.** The MCP endpoint speaks OAuth 2.1 and the
   official flow pops a browser login. That's awkward for an always-on client and
   impossible for a headless setup.

**This proxy** exposes a normal local **stdio** MCP server to Claude, and on the
other side it:

- resolves the **stable** `connect.loxonecloud.com/<serial>/mcp` entry point to
  the **current** relay, and **re-resolves automatically** whenever the relay
  moves or dies (so your Claude connection just keeps working);
- performs the **OAuth login headlessly** using a Loxone username/password from a
  local `.env` (it drives the Miniserver's HTML login form directly — no browser),
  then caches and refreshes the token;
- proxies the MCP protocol (streamable HTTP ⇄ stdio) transparently.

## Features

- 🔌 **Stable** — hides the rotating relay address behind automatic re-resolution.
- 🤖 **Headless** — logs in from `.env` credentials, no browser, no clicking.
- ♻️ **Self-healing** — re-resolves the relay and refreshes/re-issues tokens on
  failure, and transparently re-initializes a dropped session.
- 🪶 **Zero runtime dependencies** — plain Node.js (≥ 20). Nothing to build.
- 🔒 **Least-privilege friendly** — log in as a dedicated, restricted Loxone user;
  tokens are cached with `0600` permissions.

## How it works

```
Claude Desktop  ──stdio(JSON-RPC)──▶  loxone-mcp-proxy  ──HTTPS(streamable MCP)──▶  Loxone relay ──▶ Miniserver
                                          │
                    1) GET connect.loxonecloud.com/<serial>/mcp → 307 → current relay "entry"
                    2) headless OAuth on the entry:
                         register client → GET authorize (HTML login form)
                         → POST username+password (+hidden fields) → ?code=…
                         → exchange code (PKCE) → access + refresh token
                    3) speak MCP to the entry with the Bearer token
                    4) on relay death / 401 / lost session → re-resolve / refresh / re-init
```

A subtle but important detail: the OAuth **`resource`** advertised by the server
is only the token **audience identifier** — it frequently points at a *different,
sometimes unreachable* relay. MCP traffic is therefore sent to the **reachable
connect-resolved entry**, not to `resource`. The proxy handles this for you.

## Requirements

- **Node.js ≥ 20** (uses the built-in `fetch`, no packages to install).
- A **Loxone Gen 2 Miniserver, firmware 17.1+**, with the **MCP Server** plugin
  added and running (Loxone Config → Network Periphery → *MCP Server*).
- A **Loxone user account** for the assistant. Create a **dedicated** one with the
  minimum rights it needs (ideally read-only to start).

## Setup

### 1. Get the code

```bash
git clone https://github.com/ivantichy/loxone-mcp-proxy.git
cd loxone-mcp-proxy
# no "npm install" needed — there are no dependencies
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env`:

```ini
LOXONE_SERIAL=504F94A1AE7A     # your Miniserver serial (MAC without colons)
LOXONE_USER=mcp                # a DEDICATED, minimal-rights Loxone user
LOXONE_PASSWORD=your-password
```

**Finding your serial:** open `http://<miniserver-ip>/jdev/cfg/api` in a browser
and read the `snr` field (e.g. `50:4F:94:A1:AE:7A` → `504F94A1AE7A`), or read it
in Loxone Config.

### 3. Verify it works

```bash
npm run login-check
```

Expected:

```
OK  Authenticated & connected.  Server: MCP Server 1.0.0
OK  11 tools available: control_find, control_command, system_status, ...
All good - this configuration works in Claude Desktop.
```

If this fails, see [Troubleshooting](#troubleshooting).

### 4. Add it to Claude Desktop

Open **Settings → Developer → Edit Config** and add a server that runs this proxy
over stdio. Point it at `src/index.js` with an absolute path:

```jsonc
{
  "mcpServers": {
    "loxone": {
      "command": "node",
      "args": ["/absolute/path/to/loxone-mcp-proxy/src/index.js"]
    }
  }
}
```

On **Windows**, escape the backslashes:

```jsonc
{
  "mcpServers": {
    "loxone": {
      "command": "node",
      "args": ["C:\\path\\to\\loxone-mcp-proxy\\src\\index.js"]
    }
  }
}
```

Credentials are read from the project's `.env`, so you don't put secrets in the
Claude config. Fully **quit and reopen** Claude Desktop, then ask it something
like *"what's on in Loxone?"*.

## What Claude can do

The tools come from your Miniserver's MCP plugin and act with **your Loxone
user's permissions**. Typical set:

| Tool | Type | Purpose |
|------|------|---------|
| `control_find`, `control_describe` | read | discover controls, rooms, categories |
| `control_state`, `system_status` | read | read current values / installation status |
| `control_history`, `control_statistics` | read | historical data & aggregates |
| `weather` | read | Loxone weather data |
| `control_command`, `control_secured_command` | write | operate controls (lights, blinds, scenes…) |
| `code_run`, `sdk_describe` | advanced | scripted access (use with care) |

To keep the assistant **read-only**, either restrict the Loxone user's rights or
disable the write tools in your MCP client's connector settings.

## Security

- **Use a dedicated Loxone user** with the least privilege necessary. The
  assistant can only see and do what that user can.
- Credentials live only in your local `.env` (git-ignored). Tokens are cached at
  `~/.loxone-mcp-proxy/cache.json` with `0600` permissions.
- Nothing is sent to any third-party cloud — the proxy talks only to Loxone's own
  connect/relay infrastructure and your Miniserver.

## Troubleshooting

Run with verbose logging (to stderr):

```bash
LOXONE_DEBUG=1 npm run login-check
```

- **`login was rejected (form re-rendered)`** — wrong `LOXONE_USER` /
  `LOXONE_PASSWORD`, or that user may not access this Miniserver.
- **`connect is rate-limited (HTTP 429)`** — the connect endpoint allows only a
  handful of requests per window; wait a minute. Normal operation caches the
  endpoint and rarely hits it.
- **`could not authenticate after N attempts`** — check the MCP Server plugin is
  added and running in Loxone Config, and that the Miniserver has external access
  / Remote Connect enabled.
- **Claude shows the server but no tools** — fully quit Claude Desktop (from the
  tray) and relaunch; confirm `npm run login-check` passes.

## Configuration reference

All optional, via `.env` or environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOXONE_SERIAL` | — | **required** — Miniserver serial (MAC, no colons) |
| `LOXONE_USER` | — | **required** — Loxone username |
| `LOXONE_PASSWORD` | — | **required** — Loxone password |
| `LOXONE_CONNECT_BASE` | `https://connect.loxonecloud.com` | Loxone Cloud connect base |
| `LOXONE_CACHE_PATH` | `~/.loxone-mcp-proxy/cache.json` | token cache location |
| `LOXONE_REDIRECT_PORT` | `41678` | loopback port used only as the OAuth redirect target |
| `LOXONE_DEBUG` | `0` | set `1` for verbose stderr logging |

## Development

```bash
npm test                 # unit tests (node:test, no deps)
LOXONE_INTEGRATION=1 npm run test:integration   # live test (needs .env + device)
```

Layout:

```
src/
  index.js       entry point (loads config, starts the stdio proxy)
  proxy.js       stdio <-> Connection bridge (newline-delimited JSON-RPC)
  connection.js  endpoint resolution, token lifecycle, session, recovery
  loxoneAuth.js  headless OAuth (register, HTML-form login, token, refresh)
  resolver.js    connect.loxonecloud.com -> current relay, cached
  cache.js       on-disk token cache
  config.js      .env + environment config
  logger.js      stderr logging (stdout is reserved for MCP)
scripts/
  login-check.js standalone connectivity/credentials check
```

## License

[MIT](./LICENSE) © Ivan Tichy

## Acknowledgements

Built for connecting Claude to Loxone's native MCP Server. Not affiliated with or
endorsed by Loxone.

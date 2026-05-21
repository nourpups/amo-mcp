# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps
- `npm run build` — compile `src/` → `dist/` via `tsc` (NodeNext ESM, target ES2022, `strict: true`)
- `npm run dev` — run from sources with `tsx` (no build step); useful when iterating on a tool
- `npm start` — run the compiled `dist/index.js`
- Smoke-test stdio without Claude: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js`
- Smoke-test HTTP (deployed): `curl -i -X POST https://<domain>/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'` — note the returned `Mcp-Session-Id` and re-send it on follow-up calls

There is no test suite and no linter; `tsc --strict` is the only static check.

## Architecture

This is an MCP server that wraps AmoCRM REST API v4 as **read-only** tools. The same compiled binary runs in two transport modes selected by `MCP_TRANSPORT`.

**Entry & wiring — `src/index.ts`:**
- Importing `./config.js` has a side effect: it validates env vars and `process.exit(1)`s on missing/invalid values before any tool registration. Don't reorder this import.
- `buildServer()` constructs a fresh `McpServer` and calls each tool module's `register(server)`. Every file under `src/tools/` must export `register(server: McpServer)` and the index must import it.
- In `stdio` mode one server instance is connected to a `StdioServerTransport`. In `http` mode `buildServer` is passed as a factory to `startHttpServer` so a **new server is built per HTTP session** (see below).

**Config — `src/config.ts`:**
- `dotenv` is loaded from `resolve(__dirname, "../.env")` — i.e. next to the binary in `dist/`, **not** `process.cwd()`. This is intentional: Claude Code spawns the stdio server with the *client project's* cwd, so reading `.env` from cwd would silently pick up the wrong file. When debugging "where did my env go", check the `.env` next to `dist/index.js` (or `/opt/amo-mcp/.env` in Docker).
- All env validation lives here and exits hard. Adding a new required env var → add validation + extend the exported `cfg` object; tools read from `cfg`, not `process.env`.

**HTTP client — `src/client.ts`:**
- One module-scope `RateLimiter` (7 RPS, sliding 1 s window) is shared by every tool call. Always go through `request()` / `paginate()` — never `fetch()` AmoCRM directly, or you bypass the limiter.
- The HTTP method is hard-coded to `GET` inside `request()`. This is the load-bearing guarantee that makes the server read-only; preserve it even when adding new tools or the `amocrm_get` escape-hatch.
- `buildQuery()` knows the AmoCRM convention: arrays serialize as `key[]=v`, nested objects as `key[sub]=v` (recursive). New filter shapes should fit this contract rather than building query strings by hand.
- `paginate()` walks `_embedded[resourceKey]` arrays via `_links.next.href` up to `maxPages`, returning `{ items, pages, truncated }`. It rebuilds params from the absolute `next` URL — callers shouldn't manually advance `page`.

**HTTP server — `src/http-server.ts`:**
- Single endpoint `POST/GET/DELETE /mcp` with stateful sessions: an `initialize` request (matched by `isInitializeRequest`) creates a new `StreamableHTTPServerTransport` + fresh `McpServer`, stored by `sessionId`. Subsequent requests must carry `Mcp-Session-Id`. The `transports` Map is the session table; `onclose` cleans it up.
- `/health` is unauthenticated (for tunnel/LB pings). `/mcp` requires `Authorization: Bearer <MCP_HTTP_AUTH_TOKEN>` compared with `timingSafeEqual`. The bearer is the **only** thing between a public URL and your AmoCRM data — don't add code paths that bypass it.
- DNS-rebinding protection is enabled only when `MCP_HTTP_ALLOWED_HOSTS` is set; in Docker it must equal `AMO_MCP_DOMAIN`.

**Tools — `src/tools/*.ts`:**
- Each tool module is independent and uses zod schemas for `inputSchema`. Pattern: validate → pass through as `Params` → call `request()` or `paginate()` → return `{ content: [{ type: "text", text: JSON.stringify(...) }] }`. The output is stringified JSON, not structured content.
- `*_list` tools follow a shared shape (`limit`, `page`, `filter`, `with`, `auto_paginate`, `max_pages`). When `auto_paginate=true`, return the paginator's `{ items, pages, truncated }`; otherwise return AmoCRM's raw response so the client sees `_links` / `_embedded`.
- `amocrm_get` (`tools/raw.ts`) is the escape-hatch. Its zod regex (`^/api/v4/[A-Za-z0-9/_\-]+$`) is the only protection against path-shape abuse — keep it strict.
- The top-level `instructions` string on the `McpServer` (`index.ts`) is shown to LLM clients. Update it when behavior changes (e.g. rate limit, "call pipelines_list first" guidance).

**Deploy — `deploy/`:**
- Two-stage `Dockerfile`: build stage runs `tsc`, runtime stage installs prod deps and copies `dist/`; runs as `node` user under `tini`. The container exposes 8765 only on the internal Docker network.
- `docker-compose.yml` pairs the app with **Caddy** as TLS terminator. Caddy auto-issues Let's Encrypt certs based on `AMO_MCP_DOMAIN` and `ACME_EMAIL` from `.env`, and proxies `/mcp` (SSE-aware) and `/health`.
- README has the deploy flow: `tar | ssh` pipe from laptop to `/opt/amo-mcp`, then `docker compose build && up -d` in `deploy/`.

## Conventions & gotchas

- ESM with NodeNext: import paths inside `src/` must end in `.js` (e.g. `import { cfg } from "./config.js"`) even though the source is `.ts`. TypeScript's `NodeNext` resolution enforces this.
- Don't introduce write operations (POST/PATCH/DELETE) to AmoCRM. The read-only contract is part of the security model, the `instructions` text, and the rate-limit budget.
- When adding a new tool: create `src/tools/<name>.ts` exporting `register`, then add an `import * as <name> from "./tools/<name>.js"` and `<name>.register(server)` line in `index.ts`. There's no auto-discovery.
- AmoCRM page size is capped at 250 server-side. `auto_paginate=true` can fan out to `max_pages * limit` rows — keep `max_pages` bounded (current cap is 20) so a misconfigured call can't hammer the API for minutes.

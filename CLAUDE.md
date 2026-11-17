# amo-mcp

Read AGENTS.md and docs/CONNECTOR.md before changes. Build with `npm ci && npm run build`; run `npm test`.

The TypeScript ESM server exposes ten read-only amoCRM API v4 tools through stdio or remote Streamable HTTP. All upstream calls MUST remain GET-only. stdio reads amo credentials from its environment. HTTP uses browser OAuth and an encrypted SQLite store; never share credentials through module-global configuration.

The static login is only a gate, not an identity or connection owner. OAuth client IDs may own multiple grants. Each MCP session is bound to its grant connection ID and every request revalidates the bearer. Refresh changes the bearer while preserving the owner. See src/auth.ts, src/store.ts and src/http-server.ts.

The public endpoint is https://mcp.coddycamp.uz/amo/mcp. Explicit path-specific discovery avoids interference with the existing Coddy MCP at the host root. Do not mount the SDK's root auth router under a prefix and assume its metadata remains correct.

Never log upstream bodies, credentials, submitted forms, authorization codes or full callback URLs. Private env and SQLite files stay outside Git and Docker build contexts. Desktop-only browser checks are the accepted permanent rule.

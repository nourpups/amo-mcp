# Remote amoCRM connector

Public MCP endpoint: `https://mcp.coddycamp.uz/amo/mcp`.

## Connect

Claude web/Desktop: add a custom connector with the endpoint above. Claude Code:

```sh
claude mcp add --transport http amo https://mcp.coddycamp.uz/amo/mcp
```

Open `/mcp`, choose amo and authenticate. Codex:

```sh
codex mcp add amo --url https://mcp.coddycamp.uz/amo/mcp
codex mcp login amo
```

ChatGPT: add a custom MCP server/app in the account or workspace settings using that endpoint and OAuth. The availability and UI depend on the account's current permissions. Workspace-wide publication is a separate action.

The browser asks for the shared connector login/password, then for an amoCRM subdomain (or account HTTPS domain) and the integration's long-lived token. Those amo credentials belong only to this OAuth connection. Connecting another application requires entering its own amo credentials. Only GET requests to amoCRM are supported.

A failed amo validation keeps you on the setup page. An expired upstream token requires disconnecting and reconnecting with a new token. Reconnection creates a new connection; it never changes another grant. Disconnect clients that support OAuth revocation; the operator can also revoke a connection using its nonsecret connection ID. The shared password does not expose a list of connections.

## Runtime

Node.js 24; HTTP mode requires `MCP_PUBLIC_URL`, `MCP_DB_PATH`, `MCP_ENCRYPTION_KEY`, `MCP_LOGIN`, `MCP_PASSWORD_HASH` and `MCP_HTTP_PORT`. Public URL is the exact HTTPS MCP endpoint, including `/amo/mcp`. Keep the encryption key stable across restarts and outside SQLite. Keep SQLite on a private persistent filesystem, writable by container UID 1000. Never commit production configuration.

stdio continues using `AMOCRM_SUBDOMAIN` and `AMOCRM_ACCESS_TOKEN`. Remote HTTP does not fall back to those global credentials.

## ccprod publication

Use `deploy/ccprod.compose.yml`, not the standalone Caddy stack: Apache already owns this host's TLS ports. Prepare the image with `deploy/Dockerfile`, label it with the verified source commit, then use the verified immutable image ID or registry digest as `AMO_MCP_IMAGE`. Compose publication has no build step. The runtime env file and persistent data directory are supplied by absolute external paths.

Include `deploy/apache-amo.inc` inside the existing TLS virtual host for `mcp.coddycamp.uz`. Preserve its DocumentRoot, root `/mcp`, root discovery, and certificate. Exclude `/amo/` requests from the existing combined access log and route them to a dedicated log format containing `%U` rather than `%r` or `%q`; otherwise authorization codes can leak through query logging. Add the include to the owning configuration template as well, so subsequent Coddy deployments preserve it.

Before publication establish a common server-side deployment gate covering every process that can replace the service or this virtual host. A new amo-only lock does not serialize existing Coddy deployment paths. Validate Apache configuration, localhost health, container UID/SQLite access, public discovery paths and recovery before switching. Retain the preceding compatible image and routing; on first install recovery removes only the new amo routing/service. Do not downgrade to the old role-unaware/global-credential HTTP implementation against the OAuth store.

Run availability monitoring before the first production change through final acceptance. Register its real sanitized JSONL source with `dev-task-state monitor-start` and execute publication through `release-run --operation forward`; this local gate complements the shared server gate. No known outage or backup is authorized by these instructions.

## Acceptance

`npm run build` and `npm test` cover OAuth and MCP integration against controlled test data. Browser tests exercise actual forms; an external amo stub is classified as mixed. Real acceptance additionally requires a user-provided amo token and an actual tool call in Claude, Codex and ChatGPT. Keep these outcomes separate.

Browser checks are permanently desktop-only for this project. Mask all secret input fields in screenshots, and disable traces, HAR and video on authenticated flows.

## Operator commands

After building, `node scripts/hash-password.mjs` reads the static login password from stdin and prints only its scrypt hash. Feed stdin directly from your secret-management process. Never place the plaintext in command arguments or shell history.

`node scripts/revoke-connection.mjs <connection-id>` revokes a connection using `MCP_DB_PATH` and `MCP_ENCRYPTION_KEY` from the process's private environment. It does not print saved credentials. All subsequent MCP calls, including existing sessions, must reject that connection.

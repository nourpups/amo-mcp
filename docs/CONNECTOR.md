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

The installed publication path is the root-owned `mcp-release` controller. Follow [controller instructions](../deploy/release/README.md) and [shared wiring](../deploy/release/WIRING.md). The controller consumes an already built immutable image, checks its source/architecture/UID, validates the complete Apache candidate tree and checks local plus public health before accepting the route. `deploy/ccprod.compose.yml` is a reference app-only configuration, not the installed executor.

The checked route template is `deploy/apache-amo.inc`; `@PORT@` is rendered by the controller. Do not include the raw template directly. The controller adds its own Include and conditional log exclusion, preserving the existing root MCP, certificate and unrelated vhost changes. OAuth requests use a dedicated access log without query strings.

Supported Apache, certificate renewal and discovered controller entrypoints share the installed OS lease. Arbitrary privileged root-shell commands remain outside that interface. Preserve the vendor executables and wiring metadata; upgrades must reverify the wrappers and loaded systemd bindings.

Monitor before publication and execute local forward operations through `dev-task-state release-run --operation forward`. A failed monitor prevents additional forward operations. Keep failure history and coverage gaps explicit; recovery uses the existing controller release ID and does not require the failed new public endpoint to be healthy. Merge permission authorizes the standard production release and its normal restart/route publication without a separate consent record or outage window. Backups and SQL still require separate user consent.

## Acceptance

`npm run build` and `npm test` cover OAuth and MCP integration against controlled test data. Browser tests exercise actual forms; an external amo stub is classified as mixed. Real acceptance additionally requires a user-provided amo token and an actual tool call in Claude, Codex and ChatGPT. Keep these outcomes separate.

Browser checks are permanently desktop-only for this project. Mask all secret input fields in screenshots, and disable traces, HAR and video on authenticated flows.

## Operator commands

After building, `node scripts/hash-password.mjs` reads the static login password from stdin and prints only its scrypt hash. Feed stdin directly from your secret-management process. Never place the plaintext in command arguments or shell history.

`node scripts/revoke-connection.mjs <connection-id>` revokes a connection using `MCP_DB_PATH` and `MCP_ENCRYPTION_KEY` from the process's private environment. It does not print saved credentials. All subsequent MCP calls, including existing sessions, must reject that connection. Existing idle streaming connections are closed on their normal session expiry; use the OAuth revocation endpoint when immediate transport shutdown is required.

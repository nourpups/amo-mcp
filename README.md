# amocrm-mcp

Read-only MCP server for amoCRM REST API v4. Supports local stdio and remote Streamable HTTP with OAuth browser authentication for Claude, Claude Code, Codex and ChatGPT.

## Remote connector

Endpoint: `https://mcp.coddycamp.uz/amo/mcp`

Add the URL in your client, sign in with the shared connector login/password, then enter your amoCRM account subdomain and long-lived integration token. Each OAuth connection keeps its own amo credentials. The amo token stays on the server and is never sent back to the assistant.

[Connection, deployment and acceptance guide](docs/CONNECTOR.md)

## Local stdio

Set `AMOCRM_SUBDOMAIN` and `AMOCRM_ACCESS_TOKEN` in your private environment, then:

```sh
npm ci
npm run build
node dist/index.js
```

You can register that command in any stdio-capable MCP client. `MCP_TRANSPORT` defaults to `stdio`. Environment loading remains relative to the installed binary, not the caller's working directory.

## Tools

`leads_list`, `leads_get`, `contacts_list`, `contacts_get`, `tasks_list`, `events_list`, `pipelines_list`, `pipeline_get`, `companies_list`, `amocrm_get`.

All upstream requests are GET-only, including the raw `/api/v4/*` tool. Page size is capped at 250; automatic pagination is bounded to at most 20 pages. Calls are limited to seven per second per amo account within the server process.

## Development

Node.js 24. `npm run build` compiles TypeScript; `npm test` runs automated checks. The browser setup flow is tested on desktop only. See [AGENTS.md](AGENTS.md) for invariants and verification rules.

The legacy standalone Caddy compose stack is not the ccprod deployment path. ccprod uses a prebuilt image behind its existing Apache TLS virtual host.

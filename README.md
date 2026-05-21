# amocrm-mcp

Read-only MCP server for **AmoCRM REST API v4**. Plugs into Claude Code (and any other MCP-compatible client) over **stdio** (local) or **Streamable HTTP** (remote).

Inspired by [mkhamzanov.com/blog/amocrm-claude-vscode-token](https://www.mkhamzanov.com/blog/amocrm-claude-vscode-token) — uses the same long-lived JWT token from AmoCRM, but exposes proper MCP tools instead of generating ad-hoc httpx scripts.

## Tools

Specialized (validated with zod):

- `leads_list`, `leads_get`
- `contacts_list`, `contacts_get`
- `tasks_list`
- `events_list` (audit log)
- `pipelines_list`, `pipeline_get`
- `companies_list`

Escape-hatch:

- `amocrm_get` — raw GET to any `/api/v4/*` endpoint. Still read-only (HTTP method is hard-coded).

## 1. Get a long-lived JWT token from AmoCRM

1. AmoCRM → **Settings → Integrations**.
2. **Create integration** → fill the form (Redirect URI `https://example.com`, grant access to all data, accept the agreement).
3. Find your integration in **Installed**.
4. Open **Keys and access** → **Generate long-lived token**. Copy the string starting with `eyJ0eXAiOiJKV1Q...` (valid ~1 year).

---

## 2. Three ways to run

| Mode | When to use |
|---|---|
| **npm (`npx`)** | Easiest for end users — no clone, no build |
| **stdio (from source)** | Hacking on the server locally |
| **Docker (Ubuntu)** | Shared server, multiple devices, mobile, teammates |

### A. Install from npm (recommended for users)

```bash
claude mcp add amocrm \
  --env AMOCRM_SUBDOMAIN=<your-subdomain> \
  --env AMOCRM_ACCESS_TOKEN=<your-long-lived-jwt> \
  -- npx -y amocrm-mcp
```

Or manually in `~/.claude.json`:

```json
{
  "mcpServers": {
    "amocrm": {
      "command": "npx",
      "args": ["-y", "amocrm-mcp"],
      "env": {
        "AMOCRM_SUBDOMAIN": "<your-subdomain>",
        "AMOCRM_ACCESS_TOKEN": "<your-long-lived-jwt>"
      }
    }
  }
}
```

In Claude Code: `/mcp` → `amocrm: connected`.

### B. Local — stdio from source

```bash
git clone https://github.com/nourgithub/amo-mcp.git
cd amo-mcp
cp .env.example .env
# edit .env — set AMOCRM_SUBDOMAIN and AMOCRM_ACCESS_TOKEN
# leave MCP_TRANSPORT=stdio
npm install
npm run build
claude mcp add amocrm -- node "$(pwd)/dist/index.js"
```

### C. Remote — Docker on Ubuntu

Everything ships in [`deploy/`](deploy/):

- `deploy/Dockerfile` — multi-stage Node 20 alpine build, runs as non-root user with `tini` for clean signals
- `deploy/docker-compose.yml` — two services: the app + Caddy as TLS-terminating reverse proxy
- `deploy/Caddyfile` — auto-HTTPS via Let's Encrypt, proxies `/mcp` (with SSE support) and `/health`

#### Step by step

Pre-requisites: an Ubuntu server with a public IP and a DNS A-record pointing your domain at it.

```bash
# 1) Install Docker + Compose plugin (Ubuntu 22.04 / 24.04)
ssh root@SERVER_IP
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 2) Open ports 80 and 443 (if ufw is on; skip otherwise)
ufw allow 80/tcp
ufw allow 443/tcp
```

Then, **from your laptop**, push the project to the server (no need to pull npm deps locally — the image builds inside Docker):

```bash
# From D:\amo-mcp on the laptop. tar pipe — works in Git Bash / WSL / MSYS.
tar -czf - -C /d/amo-mcp \
  --exclude='./node_modules' --exclude='./dist' --exclude='./.env' --exclude='./.git' . \
  | ssh -p 22 root@SERVER_IP "mkdir -p /opt/amo-mcp && tar -xzf - -C /opt/amo-mcp"
```

(If you SSH on a non-default port, change `-p 22` and use the same number with `ssh` everywhere below.)

Back on the **server**, prepare `.env`:

```bash
ssh root@SERVER_IP
cd /opt/amo-mcp
cp .env.example .env
nano .env
```

Fill at minimum:

```
AMOCRM_SUBDOMAIN=<yours>
AMOCRM_ACCESS_TOKEN=<your long-lived JWT>

MCP_TRANSPORT=http
MCP_HTTP_PORT=8765
MCP_HTTP_AUTH_TOKEN=<openssl rand -hex 32>
MCP_HTTP_ALLOWED_HOSTS=amo-mcp.example.com

AMO_MCP_DOMAIN=amo-mcp.example.com
ACME_EMAIL=you@example.com
```

`chmod 600 .env` to keep secrets out of other users' eyes.

Build and start:

```bash
cd /opt/amo-mcp/deploy
docker compose build
docker compose up -d
docker compose ps           # both services should be "running" / "healthy"
docker compose logs -f      # watch Caddy fetch the cert (5–30s)
```

#### Verify

```bash
curl https://amo-mcp.example.com/health
# {"ok":true,"name":"amocrm-mcp"}

curl -i -X POST https://amo-mcp.example.com/mcp
# 401 — missing bearer (expected — auth works)
```

#### Connect Claude Code (any device, any OS)

```bash
claude mcp add --transport http amocrm https://amo-mcp.example.com/mcp \
  --header "Authorization: Bearer <your MCP_HTTP_AUTH_TOKEN>"
```

Then `/mcp` → `amocrm: connected`.

#### Updating the server

After you change code locally:

```bash
# laptop:
tar -czf - -C /d/amo-mcp \
  --exclude='./node_modules' --exclude='./dist' --exclude='./.env' --exclude='./.git' . \
  | ssh root@SERVER_IP "tar -xzf - -C /opt/amo-mcp"

# server:
ssh root@SERVER_IP "cd /opt/amo-mcp/deploy && docker compose build && docker compose up -d"
```

#### Useful commands

```bash
docker compose logs -f amo-mcp    # app logs
docker compose logs -f caddy      # cert issuance / proxy errors
docker compose restart amo-mcp    # restart only the app (e.g. after .env change)
docker compose down               # stop everything (data volumes preserved)
docker compose pull && docker compose up -d   # update Caddy image
```

---

## API limits & behavior

| Limit | Value | Notes |
|---|---|---|
| Rate limit | 7 RPS | Enforced in-process via a token bucket — extra calls wait. |
| Page size | 250 | Each `*_list` tool exposes `limit` (default 50). |
| `auto_paginate` | up to `max_pages` × 250 rows | Off by default. Set `auto_paginate=true` to walk `_links.next`. |
| HTTP methods to AmoCRM | GET only | Even `amocrm_get` is hard-coded. No mutations. |
| Token lifetime | ~1 year | Regenerate yearly via the same flow. |

## Security notes (HTTP / Docker mode)

- `MCP_HTTP_AUTH_TOKEN` is **mandatory** — server refuses to start without it. Constant-time comparison.
- HTTPS is handled by Caddy and is automatic — no manual cert work.
- The AmoCRM token never leaves the server. Clients only see your bearer token; rotate it without touching AmoCRM.
- `MCP_HTTP_ALLOWED_HOSTS` should match `AMO_MCP_DOMAIN` — protects against DNS-rebinding.
- The app container exposes port `8765` only on the internal Docker network — only Caddy can reach it.

## Project layout

```
amo-mcp/
├── src/
│   ├── index.ts          # entry: picks transport, registers tools
│   ├── config.ts         # loads .env (next to binary), validates required vars
│   ├── client.ts         # fetch wrapper, rate limiter, paginator
│   ├── http-server.ts    # Express + StreamableHTTPServerTransport + bearer auth
│   └── tools/
│       ├── leads.ts
│       ├── contacts.ts
│       ├── tasks.ts
│       ├── events.ts
│       ├── pipelines.ts
│       ├── companies.ts
│       └── raw.ts        # amocrm_get escape-hatch
├── deploy/
│   ├── Dockerfile        # multi-stage build, non-root, tini
│   ├── docker-compose.yml
│   └── Caddyfile         # auto-HTTPS, SSE-aware reverse proxy
├── .env.example
├── .dockerignore
├── package.json
└── tsconfig.json
```

## Smoke test without Claude

**stdio:**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

**HTTP** (in Docker):

```bash
curl -sS -X POST https://amo-mcp.example.com/mcp \
  -H "Authorization: Bearer $MCP_HTTP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i
# Note the Mcp-Session-Id header in the response — pass it as Mcp-Session-Id
# on follow-up requests (e.g. tools/list).
```

# Connector acceptance — 17 November 2026

Implemented: shared static login followed by per-connection amoCRM domain/token entry, OAuth authorization code + S256 PKCE, DCR, confidential/public client authentication, refresh/revoke, encrypted SQLite grants and immutable MCP session ownership. All ten upstream tools remain GET-only; stdio remains supported.

Verified locally with Node 24:

- TypeScript build passed. Eleven automated tests passed covering grant/session isolation, code replay/races, client/redirect/resource binding, refresh/revoke, persistence, CSRF, domain validation and all ten tools.
- Desktop Chromium exercised actual app/OAuth forms and SQLite with an external amo validation stub: wrong login, rejected integration token, two concurrent browser flows, consent/client identity, external-origin HTTPS callbacks, token exchange and authenticated MCP initialize passed. This is mixed integration, not live amoCRM acceptance.
- Screenshots of setup/error states were reviewed with token fields masked. Browser verification found and drove fixes for external-callback CSP and the Origin-null effect of Referrer-Policy no-referrer; final same-origin policy keeps external referrers suppressed.
- Independent review found and verified correction of the container healthcheck Host header. No remaining confirmed code findings at review commit fe30bfe.
- Docker build and local container startup passed on linux/arm64. Read-only container root, UID1000 and writable private SQLite were verified. This local image is not a linux/amd64 production artifact for ccprod.
- npm audit reported zero vulnerabilities after upgrading the SDK, Express/transitives and zod4. Enum-key ordering retains optional fields under zod4.

Not yet verified/published:

- Public routing and production runtime on ccprod. Existing common Apache MCP route publication has no verified shared gate; no production files, SQL or processes were changed.
- Real upstream amoCRM and actual Claude, Codex and ChatGPT application sessions. The user clarified that each end user supplies their own amo domain/token during connection; an operator integration token is not a prerequisite for running the service.

The planned public URL is https://mcp.coddycamp.uz/amo/mcp. It is not yet a released endpoint. Shared login credentials are in the selected local access store only and have not been printed or committed. Backup creation was not performed.

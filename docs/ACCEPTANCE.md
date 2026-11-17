# Connector acceptance — 17 November 2026

## Production update

- Published at `https://mcp.coddycamp.uz/amo/mcp`. App source `f76e6fd80b5b7760aef2d8de55666f8311630e9d`, immutable amd64 image `sha256:492c334737e4ff3166191544151bcfec342131f245eef6412a452e3a0a1356e0`; shared controller source `0decfa1d4a04213d322529c85c0e9ce73b980e06`, accepted main `c5d83d5ae49d9b75977ac632e15058b57e94eff6`. App build inputs are unchanged between app and controller sources.
- Eleven application tests and 25 controller/installer checks passed, including the real Linux kernel lease case and a full isolated Apache configtest. The installed helper, five wrappers and two loaded systemd bindings were checked. Six competing standard invocations were denied while the actual common lease was held.
- Production Chromium verified public discovery, deployed source identity, static login and the empty per-connection amo setup form. Screenshot reviewed with the token field masked. Existing Coddy/Junior OAuth issuers and protected MCP endpoints remained correct. New container UID1000, restart count0 and query-free access logging were verified.
- Route publication took 2.52 seconds. The verified CI job ran 13 seconds; run queue0 seconds, runner allocation3 seconds.
- Monitoring outcome is **incomplete/failed**, not fully green: four local observer/source gaps (~307,278,1052,308 seconds) coincide with Mac sleep/wake records, and one Junior MCP request received no HTTP response at16:25:11UTC. Subsequent direct checks returned200 for all four services. The HTTP failure cause is unresolved; no httpd journal restart/error event was found in its window. New amo sampling started126 seconds after publication; no amo HTTP failure was observed in the collected samples. No further production changes followed discovery of the monitor incident.
- Certbot renewal was already in a failed state before this task. The shared wiring was installed and contention-tested; that pre-existing renewal failure was not repaired.
- Real successful amo data calls and complete sessions in actual Claude/Codex/ChatGPT applications await an end user entering a valid domain/token. No operator integration token is required or embedded.

## Before-publication checkpoint (historical)

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

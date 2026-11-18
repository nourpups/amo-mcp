# amo-mcp runbook

- Main repository: https://github.com/nourpups/amo-mcp. TypeScript ESM, Node.js 24.
- Preserve GET-only amoCRM operations and existing stdio tool names/contracts.
- HTTP uses OAuth; shared static login is only an entry gate. Each grant owns separate amo credentials. Never key ownership by shared login or OAuth client ID.
- Permanent user decision, 17 November 2026: browser checks for amo-mcp are desktop only; skip mobile viewports in all worktrees.
- Run `npm ci`, `npm run build`, `npm test`; browser acceptance follows the global browser-verification skill.
- Never log credentials, Authorization headers, submitted form bodies, authorization codes or full callback URLs.
- SQLite files/keys belong outside Git and container layers. Test DBs must be local temporary files.
- Deployment: app-only Docker behind existing Apache; see docs/CONNECTOR.md. Merge permission for main authorizes the standard production publication and its normal restart/route update, without separate per-release consent, owner confirmation or an interruption window. Keep normal CI, health checks, serialization, monitoring and recovery. SQL changes and backups still require separate user consent.

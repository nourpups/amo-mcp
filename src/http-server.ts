import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createAuth, type AuthOptions } from "./auth.js";
import { AmoClient } from "./client.js";

type Connection = { connectionId: string; subdomain: string; token: string };
type AuthService = {
  router: express.Router;
  verify(token: string): Promise<Connection>;
  close(): void;
};
export type HttpOptions = Omit<AuthOptions, "validateAmo" | "onRevoke"> & {
  port: number;
  allowedHosts?: string[];
  maxSessions?: number;
  sessionTtlMs?: number;
  authFactory?: (options: AuthOptions) => AuthService;
};
type Session = {
  connectionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  touchedAt: number;
};

export function createHttpApp(
  buildServer: (client: AmoClient) => McpServer,
  opts: HttpOptions,
) {
  const app = express();
  app.disable("x-powered-by");
  // Exactly one local reverse proxy. Never trust arbitrary forwarded addresses.
  app.set("trust proxy", "loopback");
  const endpoint = new URL(opts.publicUrl);
  const prefix = endpoint.pathname.slice(0, -4);
  const sessions = new Map<string, Session>();
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const closeSession = async (id: string, session: Session) => {
    sessions.delete(id);
    await session.server.close().catch(() => {});
  };
  const auth = (opts.authFactory ?? createAuth)({
    ...opts,
    validateAmo: async (subdomain, token) => {
      await new AmoClient({ subdomain, token }).request("/api/v4/account");
    },
    onRevoke: async (connectionId) => {
      await Promise.all(
        [...sessions]
          .filter(([, s]) => s.connectionId === connectionId)
          .map(([id, s]) => closeSession(id, s)),
      );
    },
  });
  const allowedHosts = new Set(opts.allowedHosts ?? [endpoint.host]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.status(403).json({ error: "Invalid host" });
      return;
    }
    // MCP is not a cross-origin browser API. Native clients do not send Origin.
    const origin = req.headers.origin;
    if (origin && origin !== endpoint.origin) {
      res.status(403).json({ error: "Invalid origin" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use(auth.router);
  app.get(`${prefix}/health`, (_req, res) =>
    res.json({ ok: true, name: "amocrm-mcp", version: "0.2.0" }),
  );
  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${endpoint.pathname}`,
    endpoint,
  ).href;
  const unauthenticated = (res: Response) =>
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadataUrl}", scope="amo:read"`,
      )
      .json({ error: "Authentication required" });
  app.all(endpoint.pathname, async (req: Request, res: Response) => {
    try {
      if (!["POST", "GET", "DELETE"].includes(req.method)) {
        res.set("Allow", "POST, GET, DELETE").status(405).end();
        return;
      }
      const header = req.headers.authorization;
      let connection: Connection;
      try {
        if (!header?.startsWith("Bearer ")) {
          unauthenticated(res);
          return;
        }
        connection = await auth.verify(header.slice(7));
      } catch {
        unauthenticated(res);
        return;
      }
      const rawId = req.headers["mcp-session-id"];
      const sessionId = typeof rawId === "string" ? rawId : undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (
        sessionId &&
        (!session || session.connectionId !== connection.connectionId)
      ) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session && Date.now() - session.touchedAt > ttl) {
        await closeSession(sessionId!, session);
        res.status(404).json({ error: "Session expired" });
        return;
      }
      if (!session) {
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({ error: "Initialize a new MCP session" });
          return;
        }
        if (sessions.size >= (opts.maxSessions ?? 200)) {
          res.status(503).json({ error: "Session capacity reached" });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          // Host and Origin are checked above for all routes, including auth.
          onsessioninitialized: (id) => {
            sessions.set(id, newSession);
          },
        });
        const server = buildServer(new AmoClient(connection));
        const newSession: Session = {
          connectionId: connection.connectionId,
          transport,
          server,
          touchedAt: Date.now(),
        };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = newSession;
      }
      session.touchedAt = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } catch {
      // Upstream errors can contain private payloads. Keep diagnostics categorical.
      console.error("[amocrm-mcp] MCP request failed");
      if (!res.headersSent) res.status(500).json({ error: "Request failed" });
    }
  });
  app.use(
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (!res.headersSent) res.status(400).json({ error: "Invalid request" });
    },
  );
  const cleanup = setInterval(() => {
    for (const [id, s] of sessions)
      if (Date.now() - s.touchedAt > ttl) void closeSession(id, s);
  }, 60_000);
  cleanup.unref();
  return {
    app,
    close: async () => {
      clearInterval(cleanup);
      await Promise.all([...sessions].map(([id, s]) => closeSession(id, s)));
      auth.close();
    },
  };
}
export async function startHttpServer(
  buildServer: (client: AmoClient) => McpServer,
  opts: HttpOptions,
): Promise<void> {
  const service = createHttpApp(buildServer, opts);
  await new Promise<void>((resolve, reject) => {
    const server = service.app.listen(opts.port, () => {
      console.error(`[amocrm-mcp] HTTP on :${opts.port}`);
      resolve();
    });
    server.once("error", reject);
    const shutdown = async () => {
      server.close();
      await service.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
}

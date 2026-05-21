import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type HttpOptions = {
  port: number;
  authToken: string;
  allowedHosts?: string[];
};

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function startHttpServer(
  buildServer: () => McpServer,
  opts: HttpOptions
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Bearer-auth: единственный заслон между публичным URL и AmoCRM.
  // Включает /mcp и /health отдельно? Нет — /health без auth, чтобы можно
  // было пинговать туннель/балансировщик. На /mcp — всегда проверяем.
  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization;
    if (!hdr || !hdr.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const provided = hdr.slice("Bearer ".length).trim();
    if (!timingSafeEqualString(provided, opts.authToken)) {
      res.status(401).json({ error: "invalid bearer token" });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "amocrm-mcp" });
  });

  // Stateful sessions: session-id выдаётся при initialize, дальше клиент
  // отправляет его в заголовке Mcp-Session-Id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        const isInit = req.method === "POST" && isInitializeRequest(req.body);
        if (!isInit) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: no session and not an initialize request",
            },
            id: null,
          });
          return;
        }

        const newTransport: StreamableHTTPServerTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: Boolean(opts.allowedHosts?.length),
            allowedHosts: opts.allowedHosts,
            onsessioninitialized: (id) => {
              transports.set(id, newTransport);
            },
          });
        newTransport.onclose = () => {
          const id = newTransport.sessionId;
          if (id) transports.delete(id);
        };

        const server = buildServer();
        await server.connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[amocrm-mcp] /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      }
    }
  });

  await new Promise<void>((resolve) => {
    const httpServer = app.listen(opts.port, () => {
      console.error(
        `[amocrm-mcp] HTTP on :${opts.port} — endpoint POST/GET/DELETE /mcp (bearer required)`
      );
      resolve();
    });

    const shutdown = async (signal: string) => {
      console.error(`[amocrm-mcp] ${signal} — closing HTTP server`);
      httpServer.close();
      for (const [id, t] of transports) {
        try {
          await t.close();
        } catch {
          /* ignore */
        }
        transports.delete(id);
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cfg } from "./config.js";
import { AmoClient } from "./client.js";
import { buildServer } from "./server.js";
import { startHttpServer } from "./http-server.js";

async function main() {
  if (cfg.transport === "http") {
    await startHttpServer(buildServer, cfg.http);
    return;
  }

  // stdio (default)
  const server = buildServer(new AmoClient(cfg.credentials!));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[amocrm-mcp] running on stdio");

  process.on("SIGINT", async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  });
  process.on("SIGTERM", async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error("[amocrm-mcp] startup failed; verify configuration");
  process.exit(1);
});

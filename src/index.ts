#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Импорт config.ts срабатывает сразу — он валидирует .env и при отсутствии
// AMOCRM_SUBDOMAIN/AMOCRM_ACCESS_TOKEN убивает процесс с понятным stderr.
import { cfg } from "./config.js";

import * as leads from "./tools/leads.js";
import * as contacts from "./tools/contacts.js";
import * as tasks from "./tools/tasks.js";
import * as events from "./tools/events.js";
import * as pipelines from "./tools/pipelines.js";
import * as companies from "./tools/companies.js";
import * as raw from "./tools/raw.js";
import { startHttpServer } from "./http-server.js";

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "amocrm", version: "0.1.0" },
    {
      instructions: [
        "Read-only MCP server for AmoCRM REST API v4.",
        "Always call pipelines_list first to learn pipeline/status ids before filtering leads_list.",
        "Page size limit is 250; use auto_paginate=true with care — it can fetch up to max_pages*limit rows.",
        "Rate limit is 7 requests/sec (server-side throttled).",
      ].join(" "),
    }
  );

  leads.register(server);
  contacts.register(server);
  tasks.register(server);
  events.register(server);
  pipelines.register(server);
  companies.register(server);
  raw.register(server);

  return server;
}

async function main() {
  if (cfg.transport === "http") {
    await startHttpServer(buildServer, {
      port: cfg.http.port,
      authToken: cfg.http.authToken,
      allowedHosts: cfg.http.allowedHosts,
    });
    return;
  }

  // stdio (default)
  const server = buildServer();
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
  console.error("[amocrm-mcp] fatal:", err);
  process.exit(1);
});

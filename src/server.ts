import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as leads from "./tools/leads.js";
import * as contacts from "./tools/contacts.js";
import * as tasks from "./tools/tasks.js";
import * as events from "./tools/events.js";
import * as pipelines from "./tools/pipelines.js";
import * as companies from "./tools/companies.js";
import * as raw from "./tools/raw.js";
import { AmoClient } from "./client.js";

export function buildServer(client: AmoClient): McpServer {
  const server = new McpServer(
    { name: "amocrm", version: "0.2.0" },
    {
      instructions: [
        "Read-only MCP server for AmoCRM REST API v4.",
        "Always call pipelines_list first to learn pipeline/status ids before filtering leads_list.",
        "Page size limit is 250; use auto_paginate=true with care — it can fetch up to max_pages*limit rows.",
        "Rate limit is 7 requests/sec (server-side throttled).",
      ].join(" "),
    },
  );

  leads.register(server, client);
  contacts.register(server, client);
  tasks.register(server, client);
  events.register(server, client);
  pipelines.register(server, client);
  companies.register(server, client);
  raw.register(server, client);

  return server;
}

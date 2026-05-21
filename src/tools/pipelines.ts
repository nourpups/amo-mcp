import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { request } from "../client.js";

export function register(server: McpServer) {
  server.registerTool(
    "pipelines_list",
    {
      title: "List AmoCRM pipelines with statuses",
      description:
        "Get all sales pipelines and their statuses. Call this first to learn the structure before filtering leads_list by status_id.",
      inputSchema: {},
    },
    async () => {
      const data = await request("/api/v4/leads/pipelines");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "pipeline_get",
    {
      title: "Get one AmoCRM pipeline with its statuses",
      description: "Get a single pipeline by id, including its statuses.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const data = await request(`/api/v4/leads/pipelines/${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}

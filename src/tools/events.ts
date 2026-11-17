import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmoClient, type Params } from "../client.js";

const eventFilter = z
  .object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    entity: z
      .enum(["lead", "contact", "company", "customer", "task"])
      .optional(),
    entity_id: z.union([z.number(), z.array(z.number())]).optional(),
    created_by: z.union([z.number(), z.array(z.number())]).optional(),
    created_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
  })
  .optional();

export function register(server: McpServer, client: AmoClient) {
  server.registerTool(
    "events_list",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["amo:read"] }] },
      title: "List AmoCRM events (audit log)",
      description:
        "Get the audit log of changes (lead_added, lead_status_changed, task_completed, etc.). Filter by type, entity, created_by, created_at range.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
        filter: eventFilter,
        with: z.array(z.enum(["loss_reason"])).optional(),
        auto_paginate: z.boolean().default(false),
        max_pages: z.number().int().min(1).max(20).default(4),
      },
    },
    async (input) => {
      const { auto_paginate, max_pages, ...rest } = input;
      const params: Params = rest as Params;
      if (auto_paginate) {
        const { items, pages, truncated } = await client.paginate(
          "/api/v4/events",
          params,
          "events",
          max_pages,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { events: items, pages, truncated },
                null,
                2,
              ),
            },
          ],
        };
      }
      const data = await client.request("/api/v4/events", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}

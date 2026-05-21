import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paginate, request, type Params } from "../client.js";

const taskFilter = z
  .object({
    responsible_user_id: z.union([z.number(), z.array(z.number())]).optional(),
    entity_type: z.enum(["leads", "contacts", "companies", "customers"]).optional(),
    entity_id: z.number().int().positive().optional(),
    is_completed: z.union([z.literal(0), z.literal(1)]).optional(),
    task_type: z.union([z.number(), z.array(z.number())]).optional(),
    updated_at: z.object({ from: z.number().optional(), to: z.number().optional() }).optional(),
    id: z.union([z.number(), z.array(z.number())]).optional(),
  })
  .optional();

export function register(server: McpServer) {
  server.registerTool(
    "tasks_list",
    {
      title: "List AmoCRM tasks",
      description:
        "Get tasks. Useful filters: is_completed (0/1), entity_type+entity_id, responsible_user_id, task_type. Combine with order={created_at:'desc'}.",
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
        page: z.number().int().min(1).default(1),
        order: z
          .record(
            z.enum(["created_at", "complete_till", "id"]),
            z.enum(["asc", "desc"])
          )
          .optional(),
        filter: taskFilter,
        auto_paginate: z.boolean().default(false),
        max_pages: z.number().int().min(1).max(20).default(4),
      },
    },
    async (input) => {
      const { auto_paginate, max_pages, ...rest } = input;
      const params: Params = rest as Params;
      if (auto_paginate) {
        const { items, pages, truncated } = await paginate(
          "/api/v4/tasks",
          params,
          "tasks",
          max_pages
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tasks: items, pages, truncated }, null, 2),
            },
          ],
        };
      }
      const data = await request("/api/v4/tasks", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}

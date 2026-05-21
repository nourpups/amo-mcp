import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paginate, request, type Params } from "../client.js";

const contactFilter = z
  .object({
    id: z.union([z.number(), z.array(z.number())]).optional(),
    responsible_user_id: z.union([z.number(), z.array(z.number())]).optional(),
    created_at: z.object({ from: z.number().optional(), to: z.number().optional() }).optional(),
    updated_at: z.object({ from: z.number().optional(), to: z.number().optional() }).optional(),
    query: z.string().optional(),
  })
  .optional();

const withSchema = z.array(z.enum(["leads", "customers", "catalog_elements"])).optional();

export function register(server: McpServer) {
  server.registerTool(
    "contacts_list",
    {
      title: "List AmoCRM contacts",
      description:
        "Get contacts with optional filter/query/order. Page size up to 250. Set auto_paginate=true to fetch up to max_pages pages.",
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
        page: z.number().int().min(1).default(1),
        query: z.string().optional(),
        order: z
          .record(z.enum(["created_at", "updated_at", "id"]), z.enum(["asc", "desc"]))
          .optional(),
        filter: contactFilter,
        with: withSchema,
        auto_paginate: z.boolean().default(false),
        max_pages: z.number().int().min(1).max(20).default(4),
      },
    },
    async (input) => {
      const { auto_paginate, max_pages, ...rest } = input;
      const params: Params = rest as Params;
      if (auto_paginate) {
        const { items, pages, truncated } = await paginate(
          "/api/v4/contacts",
          params,
          "contacts",
          max_pages
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ contacts: items, pages, truncated }, null, 2),
            },
          ],
        };
      }
      const data = await request("/api/v4/contacts", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "contacts_get",
    {
      title: "Get one AmoCRM contact",
      description: "Get a single contact by id with optional related entities.",
      inputSchema: {
        id: z.number().int().positive(),
        with: withSchema,
      },
    },
    async ({ id, ...rest }) => {
      const data = await request(`/api/v4/contacts/${id}`, rest as Params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}

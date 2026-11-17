import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmoClient, type Params } from "../client.js";

const companyFilter = z
  .object({
    id: z.union([z.number(), z.array(z.number())]).optional(),
    responsible_user_id: z.union([z.number(), z.array(z.number())]).optional(),
    created_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
    updated_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
    query: z.string().optional(),
  })
  .optional();

export function register(server: McpServer, client: AmoClient) {
  server.registerTool(
    "companies_list",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["amo:read"] }] },
      title: "List AmoCRM companies",
      description:
        "Get companies with optional filter/query/order. Page size up to 250.",
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
        page: z.number().int().min(1).default(1),
        query: z.string().optional(),
        order: z
          .record(
            z.enum(["created_at", "updated_at", "id"]),
            z.enum(["asc", "desc"]),
          )
          .optional(),
        filter: companyFilter,
        with: z
          .array(z.enum(["leads", "customers", "contacts", "catalog_elements"]))
          .optional(),
        auto_paginate: z.boolean().default(false),
        max_pages: z.number().int().min(1).max(20).default(4),
      },
    },
    async (input) => {
      const { auto_paginate, max_pages, ...rest } = input;
      const params: Params = rest as Params;
      if (auto_paginate) {
        const { items, pages, truncated } = await client.paginate(
          "/api/v4/companies",
          params,
          "companies",
          max_pages,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { companies: items, pages, truncated },
                null,
                2,
              ),
            },
          ],
        };
      }
      const data = await client.request("/api/v4/companies", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}

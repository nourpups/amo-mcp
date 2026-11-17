import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmoClient, type Params } from "../client.js";

const filterSchema = z
  .object({
    pipeline_id: z.union([z.number(), z.array(z.number())]).optional(),
    statuses: z
      .array(z.object({ pipeline_id: z.number(), status_id: z.number() }))
      .optional(),
    responsible_user_id: z.union([z.number(), z.array(z.number())]).optional(),
    created_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
    updated_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
    closed_at: z
      .object({ from: z.number().optional(), to: z.number().optional() })
      .optional(),
    query: z.string().optional(),
    id: z.union([z.number(), z.array(z.number())]).optional(),
  })
  .optional();

const withSchema = z
  .array(
    z.enum([
      "catalog_elements",
      "is_price_modified_by_robot",
      "loss_reason",
      "contacts",
      "only_deleted",
      "source_id",
    ]),
  )
  .optional();

const listShape = {
  limit: z.number().int().min(1).max(250).default(50),
  page: z.number().int().min(1).default(1),
  query: z.string().optional(),
  order: z
    .record(z.enum(["created_at", "updated_at", "id"]), z.enum(["asc", "desc"]))
    .optional(),
  filter: filterSchema,
  with: withSchema,
  auto_paginate: z.boolean().default(false),
  max_pages: z.number().int().min(1).max(20).default(4),
} as const;

export function register(server: McpServer, client: AmoClient) {
  server.registerTool(
    "leads_list",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["amo:read"] }] },
      title: "List AmoCRM leads",
      description:
        "Get a list of leads (deals). Supports filtering by pipeline/status/responsible/dates, ordering, query search, and includes via `with`. Page size up to 250. Set auto_paginate=true to walk _links.next up to max_pages.",
      inputSchema: listShape,
    },
    async (input) => {
      const { auto_paginate, max_pages, ...rest } = input;
      const params: Params = rest as Params;
      if (auto_paginate) {
        const { items, pages, truncated } = await client.paginate(
          "/api/v4/leads",
          params,
          "leads",
          max_pages,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ leads: items, pages, truncated }, null, 2),
            },
          ],
        };
      }
      const data = await client.request("/api/v4/leads", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "leads_get",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["amo:read"] }] },
      title: "Get one AmoCRM lead",
      description: "Get a single lead by id, optionally with related entities.",
      inputSchema: {
        id: z.number().int().positive(),
        with: withSchema,
      },
    },
    async ({ id, ...rest }) => {
      const data = await client.request(`/api/v4/leads/${id}`, rest as Params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}

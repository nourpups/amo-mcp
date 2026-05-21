import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { request, type Params } from "../client.js";

export function register(server: McpServer) {
  server.registerTool(
    "amocrm_get",
    {
      title: "Raw GET to AmoCRM v4",
      description:
        "Escape-hatch: raw GET request to any AmoCRM v4 endpoint. Path MUST start with /api/v4/. Use only when no specialized tool fits. Always GET (read-only).",
      inputSchema: {
        path: z
          .string()
          .regex(/^\/api\/v4\/[A-Za-z0-9/_\-]+$/, {
            message: "path must start with /api/v4/ and contain only safe characters",
          }),
        params: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string(), z.number()])),
              z.record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])),
            ])
          )
          .optional(),
      },
    },
    async ({ path, params }) => {
      const data = await request(path, (params ?? {}) as Params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}

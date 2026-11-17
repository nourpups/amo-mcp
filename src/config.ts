import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeSubdomain } from "./client.js";
dotenvConfig({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env"),
});
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
if (transport !== "stdio" && transport !== "http")
  throw new Error("MCP_TRANSPORT must be stdio or http");
const port = Number(process.env.MCP_HTTP_PORT ?? "8765");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid MCP_HTTP_PORT");
const publicUrl =
  transport === "http"
    ? required("MCP_PUBLIC_URL")
    : "https://localhost/amo/mcp";
const parsed = new URL(publicUrl);
if (
  parsed.protocol !== "https:" ||
  parsed.username ||
  parsed.password ||
  parsed.search ||
  parsed.hash ||
  !parsed.pathname.endsWith("/mcp")
)
  throw new Error("MCP_PUBLIC_URL must be an HTTPS MCP endpoint");
export const cfg = {
  transport,
  credentials:
    transport === "stdio"
      ? {
          subdomain: normalizeSubdomain(required("AMOCRM_SUBDOMAIN")),
          token: required("AMOCRM_ACCESS_TOKEN"),
        }
      : undefined,
  http: {
    port,
    publicUrl,
    allowedHosts: (process.env.MCP_HTTP_ALLOWED_HOSTS ?? parsed.host)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dbPath:
      process.env.MCP_DB_PATH ??
      resolve(dirname(fileURLToPath(import.meta.url)), "../data/amo.sqlite"),
    encryptionKey: transport === "http" ? required("MCP_ENCRYPTION_KEY") : "",
    login: transport === "http" ? required("MCP_LOGIN") : "",
    passwordHash: transport === "http" ? required("MCP_PASSWORD_HASH") : "",
  },
} as const;

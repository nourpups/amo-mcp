import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// .env подхватываем рядом с бинарём (для локального запуска через node dist/index.js
// или Docker), но не падаем, если файла нет — глобальная установка через
// `npx -y amocrm-mcp` обычно получает env через `claude mcp add --env …`.
// dotenv по умолчанию не перезаписывает уже выставленные переменные.
dotenvConfig({ path: resolve(here, "../.env") });

const subdomain = process.env.AMOCRM_SUBDOMAIN?.trim();
const token = process.env.AMOCRM_ACCESS_TOKEN?.trim();

if (!subdomain) {
  console.error(
    "[amocrm-mcp] AMOCRM_SUBDOMAIN is not set. " +
      "Pass it via environment (e.g. `claude mcp add amocrm --env AMOCRM_SUBDOMAIN=… --env AMOCRM_ACCESS_TOKEN=… -- npx -y amocrm-mcp`) " +
      "or put it in an .env file next to the binary."
  );
  process.exit(1);
}
if (!token) {
  console.error(
    "[amocrm-mcp] AMOCRM_ACCESS_TOKEN is not set. " +
      "Pass it via environment or put it in an .env file next to the binary."
  );
  process.exit(1);
}

const rawTransport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
if (rawTransport !== "stdio" && rawTransport !== "http") {
  console.error(
    `[amocrm-mcp] MCP_TRANSPORT must be "stdio" or "http", got "${rawTransport}"`
  );
  process.exit(1);
}
const transport = rawTransport as "stdio" | "http";

const httpPort = Number(process.env.MCP_HTTP_PORT ?? "8765");
if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
  console.error(
    `[amocrm-mcp] MCP_HTTP_PORT must be a valid port (1-65535), got "${process.env.MCP_HTTP_PORT}"`
  );
  process.exit(1);
}

const httpAuthToken = process.env.MCP_HTTP_AUTH_TOKEN?.trim() ?? "";
if (transport === "http" && !httpAuthToken) {
  console.error(
    "[amocrm-mcp] MCP_HTTP_AUTH_TOKEN is required in http transport mode. " +
      "Without it, anyone reaching the URL would get read access to your AmoCRM."
  );
  process.exit(1);
}

const allowedHostsRaw = process.env.MCP_HTTP_ALLOWED_HOSTS?.trim();
const allowedHosts = allowedHostsRaw
  ? allowedHostsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

export const cfg = {
  subdomain,
  token,
  baseUrl: `https://${subdomain}.amocrm.ru`,
  transport,
  http: {
    port: httpPort,
    authToken: httpAuthToken,
    allowedHosts,
  },
} as const;

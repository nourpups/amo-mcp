import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest } from "node:http";

// Native fetch may replace Host with the URL host. Use the same explicit Host
// that the production reverse proxy preserves, without weakening server checks.
function localFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: init.method, headers: init.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode!,
              headers,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHttpApp } from "../src/http-server.js";

test("HTTP checks bearer and immutable session owner on every request, refresh preserves owner", async () => {
  let revoke: ((id: string) => void | Promise<void>) | undefined;
  const router = express.Router();
  const service = createHttpApp(
    () => new McpServer({ name: "test", version: "1" }),
    {
      port: 0,
      publicUrl: "https://test.example/amo/mcp",
      dbPath: ":memory:",
      encryptionKey: "test",
      login: "test",
      passwordHash: "test",
      allowedHosts: ["test.example"],
      authFactory: (opts) => {
        revoke = opts.onRevoke;
        return {
          router,
          close() {},
          verify: async (token) => {
            if (!["a", "a-refreshed", "b"].includes(token))
              throw new Error("invalid");
            return {
              connectionId: token.startsWith("a") ? "A" : "B",
              subdomain: "test",
              token: "amo-secret",
            };
          },
        };
      },
    },
  );
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("missing server");
  const base = `http://127.0.0.1:${addr.port}`;
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  };
  async function request(
    token?: string,
    session?: string,
    body: unknown = init,
    method = "POST",
    extra: Record<string, string> = {},
  ) {
    return localFetch(`${base}/amo/mcp`, {
      method,
      headers: {
        host: "test.example",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { "mcp-session-id": session } : {}),
        ...extra,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  }
  try {
    let response = await request();
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /oauth-protected-resource\/amo\/mcp/,
    );
    response = await request("a");
    assert.equal(response.status, 200);
    const session = response.headers.get("mcp-session-id")!;
    assert.ok(session);
    await response.text();
    response = await request("b", session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.equal(response.status, 404);
    for (const method of ["POST", "GET", "DELETE"])
      assert.equal(
        (await request(undefined, session, init, method)).status,
        401,
      );
    response = await request("a-refreshed", session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(
      (
        await request("a", session, init, "POST", {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("a", session, init, "POST", { host: "evil.example" }))
        .status,
      403,
    );
    await revoke?.("A");
    assert.equal((await request("a", session)).status, 404);
    assert.equal(
      (
        await localFetch(`${base}/amo/health`, {
          headers: { host: "test.example" },
        })
      ).status,
      200,
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r, e) =>
      server.close((err) => (err ? e(err) : r())),
    );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { AmoClient, normalizeSubdomain, buildQuery } from "../src/client.js";

test("normalizes amo origin and rejects arbitrary endpoints", () => {
  assert.equal(normalizeSubdomain("https://school.amocrm.ru/"), "school");
  for (const value of [
    "https://example.com",
    "https://a.amocrm.ru/secret",
    "a:90",
    "a@b",
    "a..b",
    "http://a.amocrm.ru",
  ])
    assert.throws(() => normalizeSubdomain(value));
});
test("GET is fixed, credentials isolated, repeated pagination params preserved", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const mock = (async (url: URL, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json(
      requests.length === 1
        ? {
            _embedded: { leads: [1] },
            _links: {
              next: {
                href: "https://first.amocrm.ru/api/v4/leads?filter%5Bid%5D%5B%5D=1&filter%5Bid%5D%5B%5D=2&page=2",
              },
            },
          }
        : { _embedded: { leads: [2] } },
    );
  }) as typeof fetch;
  const first = new AmoClient(
    { subdomain: "first", token: "first-token" },
    mock,
  );
  assert.deepEqual(
    await first.paginate("/api/v4/leads", { filter: { id: [1, 2] } }, "leads"),
    { items: [1, 2], pages: 2, truncated: false },
  );
  assert.equal(requests[1].url.searchParams.getAll("filter[id][]").length, 2);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.redirect, "error");
  const second = new AmoClient(
    { subdomain: "second", token: "second-token" },
    mock,
  );
  await second.request("/api/v4/account");
  assert.equal(
    (requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer first-token",
  );
  assert.equal(
    (requests[2].init.headers as Record<string, string>).Authorization,
    "Bearer second-token",
  );
  assert.equal(requests[2].url.origin, "https://second.amocrm.ru");
  assert.equal(
    buildQuery({ filter: { id: [1, 2] } }).toString(),
    "filter%5Bid%5D%5B%5D=1&filter%5Bid%5D%5B%5D=2",
  );
});
test("pagination rejects other origins and upstream bodies never enter error", async () => {
  const client = new AmoClient(
    { subdomain: "third", token: "private" },
    (async () =>
      Response.json({
        _links: { next: { href: "https://attacker.example/api/v4/leads" } },
      })) as typeof fetch,
  );
  await assert.rejects(
    client.paginate("/api/v4/leads", {}, "leads"),
    /Invalid amoCRM pagination/,
  );
  const bad = new AmoClient(
    { subdomain: "fourth", token: "private" },
    (async () =>
      new Response("PRIVATE TOKEN AND DATA", { status: 401 })) as typeof fetch,
  );
  await assert.rejects(
    bad.request("/api/v4/account"),
    (error) => String(error) === "AmoCRMError: amoCRM request failed (401)",
  );
  await assert.rejects(
    bad.request("//attacker.example/api/v4/leads"),
    /Invalid/,
  );
});

test("all ten tools retain their schemas and use only their injected client", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const modules = await Promise.all(
    [
      "leads",
      "contacts",
      "tasks",
      "events",
      "pipelines",
      "companies",
      "raw",
    ].map((name) => import(`../src/tools/${name}.js`)),
  );
  const captured: string[] = [];
  const amo = new AmoClient(
    { subdomain: "tool-tests", token: "isolated-token" },
    (async (url: URL, init: RequestInit) => {
      assert.equal(init.method, "GET");
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer isolated-token",
      );
      captured.push(url.pathname);
      return Response.json({ ok: true });
    }) as typeof fetch,
  );
  const server = new McpServer({ name: "tools-test", version: "1" });
  for (const mod of modules) mod.register(server, amo);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 10);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.deepEqual(tool._meta?.securitySchemes, [
        { type: "oauth2", scopes: ["amo:read"] },
      ]);
    }
    for (const [name, args] of Object.entries({
      leads_list: { order: { id: "desc" } },
      leads_get: { id: 1 },
      contacts_list: { order: { id: "desc" } },
      contacts_get: { id: 1 },
      tasks_list: {},
      events_list: {},
      pipelines_list: {},
      pipeline_get: { id: 1 },
      companies_list: {},
      amocrm_get: { path: "/api/v4/account" },
    })) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
    }
    assert.deepEqual(captured, [
      "/api/v4/leads",
      "/api/v4/leads/1",
      "/api/v4/contacts",
      "/api/v4/contacts/1",
      "/api/v4/tasks",
      "/api/v4/events",
      "/api/v4/leads/pipelines",
      "/api/v4/leads/pipelines/1",
      "/api/v4/companies",
      "/api/v4/account",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

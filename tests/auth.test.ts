import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAuth, hashPassword, verifyPassword, normalizeAmoDomain } from "../src/auth.js";
import { AuthStore } from "../src/store.js";

const PUBLIC = "https://mcp.coddycamp.uz/amo/mcp";
const PASSWORD = "local-test-password";
const passwordHash = hashPassword(PASSWORD);
const fakeAmo = async (_domain: string, token: string) => { if (!token.startsWith("amo-test-")) throw new Error("A private upstream diagnostic that must never be returned"); };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amo-auth-test-"));
  const key = randomBytes(32).toString("base64");
  const dbPath = join(dir, "state.sqlite");
  const revoked: string[] = [];
  let auth = createAuth({ publicUrl: PUBLIC, dbPath, encryptionKey: key, login: "operator", passwordHash, validateAmo: fakeAmo, onRevoke: (id) => { revoked.push(id); } });
  let app = express(); app.use(auth.router);
  let server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, options: RequestInit = {}) => fetch(`${origin}${path}`, { ...options, redirect: "manual" });
  const form = (path: string, body: Record<string, string>, cookie = "") => request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(body) });
  const register = async (method = "none") => {
    const res = await request("/amo/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: ["http://127.0.0.1:3000/callback"], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(res.status, 201, await res.clone().text()); return res.json();
  };
  const begin = async (clientId: string, cookie = "", changes: Record<string, string> = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect = "http://127.0.0.1:3999/callback";
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "amo:read", resource: PUBLIC, state: "client-state", ...changes });
    const res = await request(`/amo/oauth/authorize?${query}`, { headers: { cookie } });
    return { res, verifier, redirect, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? cookie, location: res.headers.get("location")! };
  };
  const formState = async (path: string, cookie: string) => {
    const local = new URL(path, PUBLIC);
    const res = await request(local.pathname + local.search, { headers: { cookie } });
    const html = await res.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const flow = /name="flow" value="([^"]+)"/.exec(html)?.[1];
    return { res, html, csrf: csrf!, flow: flow! };
  };
  const finish = async (clientId: string, domain: string, amoToken: string, cookie = "") => {
    const started = await begin(clientId, cookie); assert.equal(started.res.status, 303);
    const login = await formState(started.location, started.cookie); assert.equal(login.res.status, 200);
    const loggedIn = await form("/amo/login", { flow: login.flow, csrf: login.csrf, login: "operator", password: PASSWORD }, started.cookie); assert.equal(loggedIn.status, 303, await loggedIn.clone().text());
    const setup = await formState(loggedIn.headers.get("location")!, started.cookie);
    const connected = await form("/amo/connect", { flow: setup.flow, csrf: setup.csrf, domain, token: amoToken }, started.cookie); assert.equal(connected.status, 303, await connected.clone().text());
    const callback = new URL(connected.headers.get("location")!); assert.equal(callback.searchParams.get("state"), "client-state"); assert.equal(callback.searchParams.get("iss"), "https://mcp.coddycamp.uz/amo");
    return { ...started, code: callback.searchParams.get("code")!, setup };
  };
  return {
    request, form, register, begin, formState, finish, revoked, dbPath, key,
    get auth() { return auth; },
    async restart() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); auth.close();
      auth = createAuth({ publicUrl: PUBLIC, dbPath, encryptionKey: key, login: "operator", passwordHash, validateAmo: fakeAmo }); app = express(); app.use(auth.router); server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); auth.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("password hashes and strict account domain parsing", () => {
  assert.ok(verifyPassword(PASSWORD, passwordHash)); assert.equal(verifyPassword("wrong", passwordHash), false); assert.equal(verifyPassword("anything", "scrypt$bad$bad"), false);
  assert.equal(normalizeAmoDomain("https://Example.amocrm.ru/"), "example"); assert.equal(normalizeAmoDomain("example"), "example");
  for (const domain of ["https://evil.test", "https://example.amocrm.ru.evil.test", "http://example.amocrm.ru", "https://user@example.amocrm.ru", "https://example.amocrm.ru/api/v4", "https://example.amocrm.ru:1234", "https://example.amocrm.ru/#test"]) assert.throws(() => normalizeAmoDomain(domain));
});

test("path-specific discovery, OAuth issuer, and invalid redirect/resource checks", async () => {
  const f = await fixture(); try {
    const metadata = await (await f.request("/.well-known/oauth-authorization-server/amo")).json();
    assert.equal(metadata.issuer, "https://mcp.coddycamp.uz/amo"); assert.equal(metadata.token_endpoint, "https://mcp.coddycamp.uz/amo/oauth/token"); assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    const resource = await (await f.request("/.well-known/oauth-protected-resource/amo/mcp")).json(); assert.equal(resource.resource, PUBLIC); assert.deepEqual(resource.authorization_servers, [metadata.issuer]);
    const client = await f.register();
    const badResource = await f.begin(client.client_id, "", { resource: "https://evil.test/mcp" }); assert.equal(badResource.res.status, 302); assert.equal(new URL(badResource.location).searchParams.get("iss"), metadata.issuer);
    const badRedirect = await f.begin(client.client_id, "", { redirect_uri: "https://evil.test/callback" }); assert.equal(badRedirect.res.status, 400); assert.equal(badRedirect.res.headers.get("location"), null);
    assert.equal((await f.request("/.well-known/oauth-authorization-server")).status, 404);
  } finally { await f.close(); }
});

test("shared login cannot bypass staged form or CSRF and upstream errors never reveal diagnostics", async () => {
  const f = await fixture(); try {
    const client = await f.register(); const started = await f.begin(client.client_id); const login = await f.formState(started.location, started.cookie);
    assert.ok(!login.html.includes('name="token"'));
    assert.equal((await f.request(`/amo/connect?flow=${login.flow}`, { headers: { cookie: started.cookie } })).status, 400);
    assert.equal((await f.form("/amo/login", { flow: login.flow, csrf: "wrong", login: "operator", password: PASSWORD }, started.cookie)).status, 400);
    assert.equal((await f.form("/amo/login", { flow: login.flow, csrf: login.csrf, login: "operator", password: PASSWORD })).status, 400);
    const rejected = await f.form("/amo/login", { flow: login.flow, csrf: login.csrf, login: "operator", password: "wrong" }, started.cookie); assert.equal(rejected.status, 401);
    const accepted = await f.form("/amo/login", { flow: login.flow, csrf: login.csrf, login: "operator", password: PASSWORD }, started.cookie); const setup = await f.formState(accepted.headers.get("location")!, started.cookie);
    assert.notEqual(setup.csrf, login.csrf); assert.ok(setup.html.includes('name="token"'));
    const badAmo = await f.form("/amo/connect", { flow: setup.flow, csrf: setup.csrf, domain: "company.amocrm.ru", token: "invalid-private-token" }, started.cookie); const html = await badAmo.text(); assert.equal(badAmo.status, 400); assert.ok(!html.includes("private-token")); assert.ok(!html.includes("upstream diagnostic")); assert.equal(badAmo.headers.get("cache-control"), "no-store");
  } finally { await f.close(); }
});

test("grants remain isolated with reused OAuth client and browser; PKCE/code binding, refresh, revoke, persistence", async () => {
  const f = await fixture(); try {
    const client = await f.register(); const other = await f.register();
    const first = await f.finish(client.client_id, "one.amocrm.ru", "amo-test-one");
    const second = await f.finish(client.client_id, "two", "amo-test-two", first.cookie);
    const exchange = (flow: typeof first, changes: Record<string, string> = {}) => f.form("/amo/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, code: flow.code, code_verifier: flow.verifier, redirect_uri: flow.redirect, resource: PUBLIC, ...changes });
    assert.equal((await exchange(first, { code_verifier: randomBytes(32).toString("base64url") })).status, 400);
    assert.equal((await exchange(first, { client_id: other.client_id })).status, 400);
    assert.equal((await exchange(first, { redirect_uri: "http://127.0.0.1:3999/different" })).status, 400);
    assert.equal((await exchange(first, { resource: "https://evil.test/mcp" })).status, 400);
    const raced = await Promise.all([exchange(first), exchange(first)]); assert.deepEqual(raced.map((r) => r.status).sort(), [200, 400]); const firstTokens = await raced.find((r) => r.status === 200)!.json();
    const secondResponse = await exchange(second); assert.equal(secondResponse.status, 200); const secondTokens = await secondResponse.json();
    const a = await f.auth.verify(firstTokens.access_token), b = await f.auth.verify(secondTokens.access_token); assert.notEqual(a.connectionId, b.connectionId); assert.equal(a.subdomain, "one"); assert.equal(a.token, "amo-test-one"); assert.equal(b.subdomain, "two"); assert.equal(b.token, "amo-test-two");
    const reusedFlow = await f.form("/amo/connect", { flow: first.setup.flow, csrf: first.setup.csrf, domain: "overwrite", token: "amo-test-overwrite" }, first.cookie); assert.equal(reusedFlow.status, 400);
    const refreshResponse = await f.form("/amo/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: firstTokens.refresh_token, resource: PUBLIC }); assert.equal(refreshResponse.status, 200, await refreshResponse.clone().text()); const refreshed = await refreshResponse.json(); assert.equal((await f.auth.verify(refreshed.access_token)).connectionId, a.connectionId); assert.equal((await f.auth.verify(firstTokens.access_token)).connectionId, a.connectionId);
    assert.equal((await f.form("/amo/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: firstTokens.refresh_token, resource: PUBLIC })).status, 400);
    await f.restart(); assert.deepEqual(await f.auth.verify(refreshed.access_token), a); assert.deepEqual(await f.auth.verify(secondTokens.access_token), b);
    const revoke = await f.form("/amo/oauth/revoke", { client_id: client.client_id, token: refreshed.refresh_token }); assert.equal(revoke.status, 200); await assert.rejects(f.auth.verify(refreshed.access_token)); await assert.rejects(f.auth.verify(firstTokens.access_token)); assert.equal((await f.auth.verify(secondTokens.access_token)).connectionId, b.connectionId);
    assert.equal(f.auth.store.revokeConnection(b.connectionId), true); await assert.rejects(f.auth.verify(secondTokens.access_token));
    const file = readFileSync(f.dbPath); assert.equal(file.includes(Buffer.from("amo-test-one")), false); assert.equal(file.includes(Buffer.from(secondTokens.access_token)), false);
  } finally { await f.close(); }
});

test("two browser tabs keep separate pending flows and wrong encryption keys fail closed", async () => {
  const f = await fixture(); try {
    const client = await f.register(); const tab1 = await f.begin(client.client_id); const tab2 = await f.begin(client.client_id, tab1.cookie);
    const form1 = await f.formState(tab1.location, tab1.cookie), form2 = await f.formState(tab2.location, tab2.cookie); assert.notEqual(form1.flow, form2.flow); assert.notEqual(form1.csrf, form2.csrf);
    assert.equal((await f.form("/amo/login", { flow: form1.flow, csrf: form2.csrf, login: "operator", password: PASSWORD }, tab1.cookie)).status, 400);
    assert.equal((await f.form("/amo/login", { flow: form1.flow, csrf: form1.csrf, login: "operator", password: PASSWORD }, tab1.cookie)).status, 303);
    assert.equal((await f.form("/amo/login", { flow: form2.flow, csrf: form2.csrf, login: "operator", password: PASSWORD }, tab2.cookie)).status, 303);
    assert.throws(() => new AuthStore(f.dbPath, randomBytes(32).toString("base64")));
  } finally { await f.close(); }
});

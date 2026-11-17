import express, { type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { AuthStore } from "./store.js";

export type Connection = { connectionId: string; subdomain: string; token: string };
export type AuthOptions = {
  publicUrl: string; dbPath: string; encryptionKey: string; login: string; passwordHash: string;
  validateAmo: (subdomain: string, token: string) => Promise<void>;
  onRevoke?: (connectionId: string) => void | Promise<void>;
};
type Grant = Connection & { clientId: string; scopes: string[]; resource: string; expires: number; revoked?: boolean };
type TokenRecord = { connectionId: string; clientId: string; scopes: string[]; resource: string; expires: number };
type Pending = { session: string; csrf: string; authenticated: boolean; params: AuthorizationParams; clientId: string; expires: number };
type CodeRecord = TokenRecord & { challenge: string; redirectUri: string };
const FLOW_MS = 10 * 60_000;
const ACCESS_MS = 60 * 60_000;
const REFRESH_MS = 30 * 24 * 60 * 60_000;
const SCOPE = "amo:read";
const SCOPES = [SCOPE, "offline_access"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, rawSalt, rawHash, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !rawSalt || !rawHash || extra) return false;
  const salt = Buffer.from(rawSalt, "base64"), expected = Buffer.from(rawHash, "base64");
  if (salt.length !== 16 || expected.length !== 32) return false;
  return timingSafeEqual(scryptSync(password, salt, 32), expected);
}

export function normalizeAmoDomain(value: string): string {
  const raw = value.trim().toLowerCase();
  const domain = raw.includes("://") ? new URL(raw) : new URL(`https://${raw.includes(".") ? raw : `${raw}.amocrm.ru`}`);
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.amocrm\.ru$/.exec(domain.hostname);
  if (!match || domain.protocol !== "https:" || domain.port || domain.username || domain.password || domain.search || domain.hash || domain.pathname !== "/") {
    throw new Error("Укажите адрес аккаунта вида company.amocrm.ru");
  }
  return match[1]!;
}

export function createAuth(options: AuthOptions) {
  const resource = new URL(options.publicUrl);
  if (resource.protocol !== "https:" || resource.search || resource.hash || !resource.pathname.endsWith("/mcp")) throw new Error("OAuth public URL must be HTTPS and end with /mcp");
  if (!options.login || !/^scrypt\$[^$]+\$[^$]+$/.test(options.passwordHash) || Buffer.from(options.passwordHash.split("$")[1] ?? "", "base64").length !== 16 || Buffer.from(options.passwordHash.split("$")[2] ?? "", "base64").length !== 32) throw new Error("Configure the shared login and a valid scrypt password hash");
  const base = resource.pathname.slice(0, -4).replace(/\/$/, "");
  const issuer = `${resource.origin}${base}`;
  const cookieName = "__Secure-amo_flow_session";
  const cookiePath = base || "/";
  const store = new AuthStore(options.dbPath, options.encryptionKey);
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.path.startsWith(`${base}/`) || req.path === `/.well-known/oauth-authorization-server${base}` || req.path === `/.well-known/oauth-protected-resource${resource.pathname}`) {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" });
    }
    next();
  });
  const cleanup = setInterval(() => store.cleanup(), 60_000); cleanup.unref();
  store.cleanup();

  const resourceCheck = (value?: URL | string) => {
    if (value && String(value) !== resource.href) throw new InvalidRequestError("Unsupported resource");
  };
  const grantFor = (id: string) => {
    const grant = store.get<Grant>("grants", id);
    if (!grant || grant.revoked || !grant.token || grant.resource !== resource.href) throw new InvalidTokenError("Connection is expired or revoked");
    return grant;
  };
  const tokenFor = (token: string, kind: "access" | "refresh") => {
    const record = store.get<TokenRecord>(kind, digest(token));
    if (!record || record.resource !== resource.href) throw new InvalidTokenError("Invalid or expired token");
    grantFor(record.connectionId);
    return record;
  };
  function issue(grant: Grant): OAuthTokens {
    const accessToken = secret(), refreshToken = secret();
    const record = { connectionId: grant.connectionId, clientId: grant.clientId, scopes: grant.scopes, resource: grant.resource };
    store.put("access", digest(accessToken), { ...record, expires: Date.now() + ACCESS_MS }, Date.now() + ACCESS_MS);
    store.put("refresh", digest(refreshToken), { ...record, expires: Date.now() + REFRESH_MS }, Date.now() + REFRESH_MS);
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refreshToken, scope: grant.scopes.join(" ") };
  }
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) => store.get<OAuthClientInformationFull>("clients", id),
      registerClient: async (client) => {
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
          if (u.username || u.password || u.hash || u.hostname.includes("*") || (u.protocol !== "https:" && !(local && u.protocol === "http:"))) throw new InvalidClientMetadataError("Redirect URIs must use HTTPS or a loopback HTTP address");
        }
        if (!["none", "client_secret_post", "client_secret_basic"].includes(client.token_endpoint_auth_method ?? "client_secret_post")) throw new InvalidClientMetadataError("Unsupported token endpoint auth method");
        const result = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), client_secret_expires_at: client.client_secret ? 0 : undefined };
        store.put("clients", result.client_id, result, Number.MAX_SAFE_INTEGER);
        return result;
      },
    },
    async authorize(client, params, res) {
      resourceCheck(params.resource);
      if (params.scopes?.some((scope) => !SCOPES.includes(scope))) throw new InvalidScopeError("Unsupported scope");
      const req = res.req;
      const cookies = (req.headers.cookie ?? "").split(";").map((v) => v.trim().split("="));
      let browser = cookies.find(([name]) => name === cookieName)?.[1];
      if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser) || !store.get("browsers", digest(browser))) browser = secret();
      const session = digest(browser);
      store.put("browsers", session, { ok: true }, Date.now() + FLOW_MS);
      res.cookie(cookieName, browser, { secure: true, httpOnly: true, sameSite: "lax", path: cookiePath, maxAge: FLOW_MS });
      const flow = secret();
      const pending: Pending = { session, csrf: secret(), authenticated: false, params, clientId: client.client_id, expires: Date.now() + FLOW_MS };
      store.put("pending", digest(flow), pending, pending.expires);
      res.redirect(303, `${base}/login?flow=${encodeURIComponent(flow)}`);
    },
    async challengeForAuthorizationCode(client, code) {
      const record = store.get<CodeRecord>("codes", digest(code));
      if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
      return record.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      return store.transaction(() => {
        resourceCheck(requestedResource);
        const record = store.get<CodeRecord>("codes", digest(code));
        if (!record || record.clientId !== client.client_id || redirectUri !== record.redirectUri) throw new InvalidGrantError("Invalid authorization code");
        const grant = grantFor(record.connectionId);
        store.delete("codes", digest(code));
        grant.expires = Date.now() + REFRESH_MS;
        store.put("grants", grant.connectionId, grant, grant.expires);
        return issue(grant);
      });
    },
    async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
      return store.transaction(() => {
        resourceCheck(requestedResource);
        let record: TokenRecord;
        try { record = tokenFor(refreshToken, "refresh"); } catch { throw new InvalidGrantError("Invalid refresh token"); }
        if (record.clientId !== client.client_id || (scopes !== undefined && (!scopes.includes(SCOPE) || scopes.some((scope) => !record.scopes.includes(scope))))) throw new InvalidGrantError("Invalid refresh token or scope");
        const grant = grantFor(record.connectionId);
        grant.expires = Date.now() + REFRESH_MS;
        store.put("grants", grant.connectionId, grant, grant.expires);
        store.delete("refresh", digest(refreshToken));
        return issue({ ...grant, scopes: scopes ?? record.scopes });
      });
    },
    async verifyAccessToken(token) {
      const record = tokenFor(token, "access");
      return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expires / 1000, resource, extra: { connectionId: record.connectionId } };
    },
    async revokeToken(client, { token }) {
      const record = store.get<TokenRecord>("access", digest(token)) ?? store.get<TokenRecord>("refresh", digest(token));
      if (record?.clientId === client.client_id && store.revokeConnection(record.connectionId)) await options.onRevoke?.(record.connectionId);
    },
  };

  const metadata = {
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true,
  };
  const metadataReply = (value: unknown) => (_req: Request, res: Response) => { res.set({ "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).json(value); };
  router.get(`/.well-known/oauth-authorization-server${base}`, metadataReply(metadata));
  // Legacy clients append the well-known path to the issuer instead of inserting it.
  router.get(`${base}/.well-known/oauth-authorization-server`, metadataReply(metadata));
  router.get(`/.well-known/oauth-protected-resource${resource.pathname}`, metadataReply({ resource: resource.href, authorization_servers: [issuer], scopes_supported: SCOPES, resource_name: "amoCRM" }));

  // Include issuer identification on SDK-generated authorization error redirects too.
  router.use(`${base}/oauth/authorize`, (_req, res, next) => {
    const original = res.redirect.bind(res) as (status: number, url: string) => void;
    res.redirect = ((status: number | string, target?: string) => {
      const location = typeof status === "string" ? status : target!;
      let url = location;
      try { const u = new URL(location); if (u.searchParams.has("code") || u.searchParams.has("error")) { u.searchParams.set("iss", issuer); url = u.href; } } catch { /* internal relative redirect */ }
      original(typeof status === "number" ? status : 302, url);
    }) as typeof res.redirect;
    next();
  }, authorizationHandler({ provider }));
  router.use(`${base}/oauth/token`, tokenHandler({ provider }));
  router.use(`${base}/oauth/register`, clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }));
  router.use(`${base}/oauth/revoke`, revocationHandler({ provider }));

  function pendingFor(req: Request): { flow: string; pending: Pending } | undefined {
    const flow = req.method === "POST" ? req.body?.flow : req.query.flow;
    if (typeof flow !== "string" || flow.length !== 43) return;
    const pending = store.get<Pending>("pending", digest(flow));
    const browser = (req.headers.cookie ?? "").split(";").map((p) => p.trim()).find((p) => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!pending || !browser || !same(digest(browser), pending.session) || !store.get("browsers", pending.session)) return;
    if (req.method === "POST" && (typeof req.body.csrf !== "string" || !same(req.body.csrf, pending.csrf))) return;
    return { flow, pending };
  }
  function form(res: Response, title: string, action: string, flow: string, csrf: string, fields: string, error = "") {
    res.type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — amoCRM MCP</title><style>body{font:16px system-ui;background:#f3f5f8;color:#182433;margin:0;padding:24px}main{max-width:420px;margin:8vh auto;background:white;padding:32px;border-radius:18px;box-shadow:0 8px 32px #18243312}h1{font-size:24px;margin-top:0}label{display:block;margin:18px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c5d4;border-radius:8px;font:inherit}button{width:100%;padding:13px;margin-top:24px;border:0;border-radius:8px;background:#1858ce;color:white;font:inherit;cursor:pointer}.error{color:#b42222}p{line-height:1.5;color:#4b5b70}</style></head><body><main><h1>${escape(title)}</h1>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}<form method="post" action="${escape(action)}"><input type="hidden" name="flow" value="${escape(flow)}"><input type="hidden" name="csrf" value="${escape(csrf)}">${fields}<button type="submit">${action.endsWith("/connect") ? "Подключить" : "Продолжить"}</button></form></main></body></html>`);
  }
  const loginFields = '<p>Войдите, чтобы подключить ваш аккаунт amoCRM.</p><label for="login">Логин</label><input id="login" name="login" autocomplete="username" required maxlength="200"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">';
  const amoFields = '<p>Данные сохранятся только для этого подключения. Доступ к amoCRM — только чтение.</p><label for="domain">Домен amoCRM</label><input id="domain" name="domain" placeholder="company.amocrm.ru" required maxlength="250" autocomplete="off"><label for="token">Долгосрочный токен интеграции</label><input id="token" name="token" type="password" required maxlength="16000" autocomplete="off"><p>Токен можно создать в amoCRM: Настройки → Интеграции → ваша интеграция → Ключи и доступы.</p>';
  const connectFields = (pending: Pending) => {
    const client = store.get<OAuthClientInformationFull>("clients", pending.clientId);
    const name = client?.client_name || "MCP-клиент";
    const callback = new URL(pending.params.redirectUri);
    return `<p><strong>${escape(name)}</strong> получит доступ на чтение к указанному аккаунту amoCRM. После подключения вы вернётесь на <strong>${escape(callback.host)}</strong>.</p>${amoFields}`;
  };
  const browserHeaders = (req: Request, res: Response, next: () => void) => {
    const pending = pendingFor(req)?.pending;
    // Chromium applies form-action to the POST's redirect chain as well.
    // Only the registered callback saved in this browser's validated flow is allowed.
    const callbackOrigin = pending ? new URL(pending.params.redirectUri).origin : "";
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ""}; frame-ancestors 'none'; base-uri 'none'` }); next();
  };
  const browserLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: "Слишком много попыток. Повторите позже." });
  router.use([`${base}/login`, `${base}/connect`], express.urlencoded({ extended: false, limit: "24kb" }), browserHeaders);
  const missing = (res: Response) => res.status(400).type("text").send("Подключение истекло или недействительно. Начните подключение заново в вашем клиенте.");
  router.get(`${base}/login`, (req, res) => {
    const state = pendingFor(req); if (!state) { missing(res); return; }
    form(res, "Вход в amoCRM MCP", `${base}/login`, state.flow, state.pending.csrf, loginFields);
  });
  router.post(`${base}/login`, browserLimit, (req, res) => {
    const state = pendingFor(req); if (!state) { missing(res); return; }
    const user = typeof req.body.login === "string" ? req.body.login : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const validPassword = password.length <= 1024 && verifyPassword(password, options.passwordHash);
    if (!validPassword || !same(user, options.login)) { res.status(401); form(res, "Вход в amoCRM MCP", `${base}/login`, state.flow, state.pending.csrf, loginFields, "Неверный логин или пароль."); return; }
    state.pending.authenticated = true; state.pending.csrf = secret();
    store.put("pending", digest(state.flow), state.pending, state.pending.expires);
    res.redirect(303, `${base}/connect?flow=${encodeURIComponent(state.flow)}`);
  });
  router.get(`${base}/connect`, (req, res) => {
    const state = pendingFor(req); if (!state || !state.pending.authenticated) { missing(res); return; }
    form(res, "Подключение amoCRM", `${base}/connect`, state.flow, state.pending.csrf, connectFields(state.pending));
  });
  router.post(`${base}/connect`, browserLimit, async (req, res) => {
    const state = pendingFor(req); if (!state || !state.pending.authenticated) { missing(res); return; }
    let subdomain: string;
    const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
    try {
      subdomain = normalizeAmoDomain(typeof req.body.domain === "string" ? req.body.domain : "");
      if (!token || token.length > 16_000 || /\s/.test(token)) throw new Error("Invalid token");
      await options.validateAmo(subdomain, token);
    } catch {
      res.status(400); form(res, "Подключение amoCRM", `${base}/connect`, state.flow, state.pending.csrf, connectFields(state.pending), "Не удалось проверить домен и токен amoCRM. Проверьте данные и срок действия токена."); return;
    }
    const code = secret();
    const done = store.transaction(() => {
      // Another tab/replayed POST may have consumed this flow while validation ran.
      const fresh = store.get<Pending>("pending", digest(state.flow));
      if (!fresh || !same(fresh.csrf, state.pending.csrf) || !fresh.authenticated) return false;
      const connectionId = randomUUID();
      const grant: Grant = { connectionId, subdomain, token, clientId: fresh.clientId, scopes: [SCOPE, ...(fresh.params.scopes?.includes("offline_access") ? ["offline_access"] : [])], resource: resource.href, expires: Date.now() + 60_000 };
      store.put("grants", connectionId, grant, grant.expires);
      store.put("codes", digest(code), { connectionId, clientId: grant.clientId, scopes: grant.scopes, resource: grant.resource, expires: Date.now() + 60_000, challenge: fresh.params.codeChallenge, redirectUri: fresh.params.redirectUri }, Date.now() + 60_000);
      store.delete("pending", digest(state.flow));
      return true;
    });
    if (!done) { missing(res); return; }
    const redirect = new URL(state.pending.params.redirectUri); redirect.searchParams.set("code", code); redirect.searchParams.set("iss", issuer);
    if (state.pending.params.state !== undefined) redirect.searchParams.set("state", state.pending.params.state);
    res.redirect(303, redirect.href);
  });
  return {
    router, store,
    async verify(token: string): Promise<Connection> {
      const record = tokenFor(token, "access");
      const grant = grantFor(record.connectionId);
      return { connectionId: grant.connectionId, subdomain: grant.subdomain, token: grant.token };
    },
    close() { clearInterval(cleanup); store.close(); },
  };
}

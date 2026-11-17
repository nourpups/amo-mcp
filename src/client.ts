const RPS_LIMIT = 7;
const WINDOW_MS = 1000;
class RateLimiter {
  private timestamps: number[] = [];
  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < WINDOW_MS);
      if (this.timestamps.length < RPS_LIMIT) {
        this.timestamps.push(now);
        return;
      }
      await new Promise((r) =>
        setTimeout(r, WINDOW_MS - (now - this.timestamps[0]!) + 5),
      );
    }
  }
}
// Sharing the same amo account must not multiply its upstream request budget.
const limiters = new Map<string, RateLimiter>();
export function normalizeSubdomain(value: string): string {
  const raw = value.trim().toLowerCase();
  if (
    raw.startsWith("https://") &&
    !/^https:\/\/[a-z0-9-]+\.amocrm\.ru\/?$/.test(raw)
  )
    throw new Error("Enter an amoCRM account domain");
  const subdomain = raw.startsWith("https://")
    ? raw
        .slice(8)
        .replace(/\/$/, "")
        .replace(/\.amocrm\.ru$/, "")
    : raw.replace(/\.amocrm\.ru$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
    throw new Error("Enter an amoCRM subdomain or HTTPS account domain");
  return subdomain;
}
type Primitive = string | number | boolean;
export type ParamValue =
  | Primitive
  | ParamValue[]
  | { [key: string]: ParamValue | undefined };
export type Params = Record<string, ParamValue | undefined>;
function appendParam(
  qs: URLSearchParams,
  key: string,
  value: ParamValue,
): void {
  if (Array.isArray(value)) {
    for (const item of value) appendParam(qs, `${key}[]`, item);
  } else if (value !== null && typeof value === "object") {
    for (const [sub, item] of Object.entries(value))
      if (item !== undefined) appendParam(qs, `${key}[${sub}]`, item);
  } else qs.append(key, String(value));
}
export function buildQuery(params: Params): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null) appendParam(qs, key, value);
  return qs;
}
export class AmoCRMError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AmoCRMError";
  }
}
export class AmoClient {
  readonly subdomain: string;
  readonly baseUrl: string;
  private limiter: RateLimiter;
  constructor(
    private credentials: { subdomain: string; token: string },
    private fetcher: typeof fetch = fetch,
  ) {
    this.subdomain = normalizeSubdomain(credentials.subdomain);
    this.baseUrl = `https://${this.subdomain}.amocrm.ru`;
    if (!credentials.token.trim() || /[\r\n]/.test(credentials.token))
      throw new Error("Invalid amoCRM token");
    this.limiter = limiters.get(this.subdomain) ?? new RateLimiter();
    limiters.set(this.subdomain, this.limiter);
  }
  private async get<T>(url: URL): Promise<T> {
    if (
      url.origin !== this.baseUrl ||
      !/^\/api\/v4\/[A-Za-z0-9/_-]+$/.test(url.pathname)
    )
      throw new Error("Invalid amoCRM endpoint");
    await this.limiter.take();
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${this.credentials.token}`,
          Accept: "application/json",
          "User-Agent": "amocrm-mcp/0.2",
        },
      });
      if (!res.ok)
        throw new AmoCRMError(
          res.status,
          `amoCRM request failed (${res.status})`,
        );
      if (res.status === 204) return { _embedded: {} } as T;
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof AmoCRMError) throw error;
      throw new AmoCRMError(502, "amoCRM request failed or timed out");
    }
  }
  async request<T = unknown>(path: string, params: Params = {}): Promise<T> {
    if (!/^\/api\/v4\/[A-Za-z0-9/_-]+$/.test(path))
      throw new Error("Invalid amoCRM endpoint");
    const url = new URL(path, this.baseUrl);
    url.search = buildQuery(params).toString();
    return this.get<T>(url);
  }
  async paginate<TResource extends string>(
    path: string,
    params: Params,
    resourceKey: TResource,
    maxPages = 4,
  ): Promise<{ items: unknown[]; pages: number; truncated: boolean }> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
      throw new Error("Invalid page budget");
    const url = new URL(path, this.baseUrl);
    url.search = buildQuery(params).toString();
    const items: unknown[] = [];
    let current = url;
    for (let pages = 1; pages <= maxPages; pages++) {
      const data = await this.get<{
        _embedded?: Partial<Record<TResource, unknown[]>>;
        _links?: { next?: { href?: string } };
      }>(current);
      const batch = data._embedded?.[resourceKey];
      if (Array.isArray(batch)) items.push(...batch);
      const next = data._links?.next?.href;
      if (!next) return { items, pages, truncated: false };
      current = new URL(next, this.baseUrl);
      // Validate even when the page budget is exhausted; never follow another origin.
      if (
        current.origin !== this.baseUrl ||
        !/^\/api\/v4\/[A-Za-z0-9/_-]+$/.test(current.pathname)
      )
        throw new Error("Invalid amoCRM pagination link");
      if (pages === maxPages) return { items, pages, truncated: true };
    }
    throw new Error("Invalid page budget");
  }
}

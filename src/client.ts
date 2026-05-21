import { cfg } from "./config.js";

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
      const oldest = this.timestamps[0]!;
      const waitMs = WINDOW_MS - (now - oldest) + 5;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const limiter = new RateLimiter();

type Primitive = string | number | boolean;
type ParamValue = Primitive | Primitive[] | Record<string, Primitive | Primitive[]>;
export type Params = Record<string, ParamValue | undefined>;

function appendParam(qs: URLSearchParams, key: string, value: ParamValue): void {
  if (Array.isArray(value)) {
    for (const v of value) qs.append(`${key}[]`, String(v));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [sub, subVal] of Object.entries(value)) {
      appendParam(qs, `${key}[${sub}]`, subVal as ParamValue);
    }
    return;
  }
  qs.append(key, String(value));
}

function buildQuery(params: Params): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    appendParam(qs, key, value);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export class AmoCRMError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = "AmoCRMError";
  }
}

export async function request<T = unknown>(
  path: string,
  params: Params = {}
): Promise<T> {
  if (!path.startsWith("/")) {
    throw new Error(`Path must start with "/": ${path}`);
  }
  await limiter.take();
  const url = `${cfg.baseUrl}${path}${buildQuery(params)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
      "User-Agent": "amocrm-mcp/0.1",
    },
  });

  if (res.status === 204) {
    return { _embedded: {} } as T;
  }

  const text = await res.text();

  if (!res.ok) {
    throw new AmoCRMError(
      res.status,
      text,
      `AmoCRM ${res.status} ${res.statusText} on GET ${path}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AmoCRMError(
      res.status,
      text,
      `AmoCRM returned non-JSON on GET ${path}: ${text.slice(0, 200)}`
    );
  }
}

type Paginated<TResource extends string> = {
  _embedded?: Partial<Record<TResource, unknown[]>>;
  _links?: { next?: { href?: string } };
  _page?: number;
  _total_items?: number;
};

export async function paginate<TResource extends string>(
  path: string,
  params: Params,
  resourceKey: TResource,
  maxPages = 4
): Promise<{ items: unknown[]; pages: number; truncated: boolean }> {
  const items: unknown[] = [];
  let currentPath = path;
  let currentParams: Params | undefined = params;
  let pages = 0;

  while (pages < maxPages) {
    const data: Paginated<TResource> = await request(currentPath, currentParams ?? {});
    pages += 1;
    const batch = data._embedded?.[resourceKey];
    if (Array.isArray(batch)) items.push(...batch);

    const nextHref = data._links?.next?.href;
    if (!nextHref) {
      return { items, pages, truncated: false };
    }
    // Дальше идём по абсолютному URL из _links.next.href — он уже содержит все параметры.
    const u = new URL(nextHref);
    currentPath = u.pathname;
    currentParams = {};
    u.searchParams.forEach((v, k) => {
      const existing = (currentParams as Record<string, unknown>)[k];
      if (existing === undefined) {
        (currentParams as Record<string, unknown>)[k] = v;
      } else if (Array.isArray(existing)) {
        (existing as string[]).push(v);
      } else {
        (currentParams as Record<string, unknown>)[k] = [existing as string, v];
      }
    });
  }

  return { items, pages, truncated: true };
}

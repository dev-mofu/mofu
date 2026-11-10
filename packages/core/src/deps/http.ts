import type { z } from "zod";

export interface HttpOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 15_000;
const RETRIES = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON request with a timeout, retries with backoff on 429/5xx and network
 * errors, and zod validation. Returns null on 404.
 */
export async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  opts: HttpOptions & { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T | null> {
  const doFetch = opts.fetch ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await doFetch(url, {
        method: opts.method ?? "GET",
        signal,
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${new URL(url).host} returned HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success)
        throw new Error(`${new URL(url).host} returned data in an unexpected format.`);
      return parsed.data;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
      if (err instanceof Error && /unexpected format|HTTP 4/.test(err.message)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Maps with at most `limit` promises in flight, keeping order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

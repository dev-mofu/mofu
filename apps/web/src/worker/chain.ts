/**
 * JSON-RPC to Robinhood Chain with fallback across several public endpoints. The official
 * endpoint rate-limits Cloudflare's shared egress IPs, so others are tried first and the next
 * one is used whenever an endpoint errors, times out or rate-limits.
 */

export class RpcError extends Error {}
/** The call ran and reverted: a real answer from the chain, so no other endpoint is tried. */
export class RevertError extends RpcError {}

/** Parses the comma-separated RPC list from config; only https URLs are kept. */
export function parseRpcUrls(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("https://"));
}

export async function rpcCall<T = unknown>(
  urls: readonly string[],
  method: string,
  params: unknown[],
  fetchFn: typeof fetch,
  timeoutMs = 8_000,
): Promise<T> {
  let last: unknown = new RpcError("No RPC endpoint configured.");
  for (const url of urls) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`);
      const body = (await res.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (body.error) {
        const message = body.error.message ?? "RPC error";
        if (body.error.code === 3 || /revert/i.test(message)) throw new RevertError(message);
        throw new RpcError(message);
      }
      if (body.result === undefined) throw new RpcError("RPC returned no result");
      return body.result;
    } catch (err) {
      if (err instanceof RevertError) throw err;
      last = err;
    }
  }
  throw last instanceof Error ? last : new RpcError("RPC failed");
}

/** eth_call returning the raw hex result. */
export function ethCall(
  urls: readonly string[],
  to: string,
  data: string,
  fetchFn: typeof fetch,
): Promise<string> {
  return rpcCall<string>(urls, "eth_call", [{ to, data }, "latest"], fetchFn);
}

export interface BatchCall {
  method: string;
  params: unknown[];
}

/** One answer of a batch: the result, or null when the call reverted. */
export type BatchResult = string | null;

/**
 * Several calls in one JSON-RPC batch (one subrequest). Endpoints that refuse batches, or answer
 * with anything but results and reverts, are skipped; when none takes the batch, the calls run
 * one by one, a few at a time.
 */
export async function rpcBatch(
  urls: readonly string[],
  calls: readonly BatchCall[],
  fetchFn: typeof fetch,
  timeoutMs = 10_000,
): Promise<BatchResult[]> {
  if (calls.length === 0) return [];
  const body = calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }));
  for (const url of urls) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const answers = (await res.json()) as Array<{
        id?: number;
        result?: string;
        error?: { code?: number; message?: string };
      }>;
      if (!Array.isArray(answers) || answers.length !== calls.length) continue;
      const out: BatchResult[] = new Array(calls.length).fill(null);
      let usable = true;
      for (const a of answers) {
        if (typeof a.id !== "number" || a.id < 0 || a.id >= calls.length) usable = false;
        else if (a.error) {
          const m = a.error.message ?? "";
          if (!(a.error.code === 3 || /revert/i.test(m))) usable = false;
        } else out[a.id] = typeof a.result === "string" ? a.result : null;
      }
      if (usable) return out;
    } catch {
      // next endpoint
    }
  }
  const out: BatchResult[] = [];
  for (let i = 0; i < calls.length; i += 3) {
    const part = await Promise.all(
      calls
        .slice(i, i + 3)
        .map((c) =>
          rpcCall<string>(urls, c.method, c.params, fetchFn, timeoutMs).catch(() => null),
        ),
    );
    out.push(...part);
  }
  return out;
}

/** eth_call as a batch entry. */
export const callOf = (to: string, data: string, from?: string): BatchCall => ({
  method: "eth_call",
  params: [from ? { from, to, data } : { to, data }, "latest"],
});

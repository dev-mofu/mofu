/**
 * JSON-RPC to Robinhood Chain with fallback across several public endpoints. The official
 * endpoint rate-limits Cloudflare's shared egress IPs, so others are tried first and the next
 * one is used whenever an endpoint errors, times out or rate-limits.
 */

export class RpcError extends Error {}

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
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new RpcError(body.error.message ?? "RPC error");
      if (body.result === undefined) throw new RpcError("RPC returned no result");
      return body.result;
    } catch (err) {
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

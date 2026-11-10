import type { z } from "zod";
import type { ToolContext } from "./types.js";

/** Identifies Mofu to public APIs that ask for a descriptive client name. */
export const USER_AGENT = "Mofu/0.1 (open-source AI agent; https://www.npmjs.com/package/mofu)";

const DEFAULT_TIMEOUT_MS = 10_000;

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/**
 * GETs JSON with a timeout and validates it with zod. A 404 becomes
 * NotFoundError so callers can answer "not found" cleanly.
 */
export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  ctx: Pick<ToolContext, "fetch" | "signal">,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const doFetch = ctx.fetch ?? fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await doFetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        // Browsers drop User-Agent; Wikimedia reads Api-User-Agent instead.
        "User-Agent": USER_AGENT,
        "Api-User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    if (timeout.aborted) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s.`, { cause: err });
    }
    throw err;
  }
  if (res.status === 404) throw new NotFoundError("Not found.");
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}.`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new Error("The service returned data in an unexpected format.");
  return parsed.data;
}

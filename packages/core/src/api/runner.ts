/**
 * Runs generated test cases against a live server. Web-safe code (fetch is
 * injected), but only the CLI uses it: the web app never calls user APIs.
 */
import { isPrivateAddress, type Resolver } from "../study/webpage.js";
import { buildRequestUrl, getPath, schemaErrors } from "./cases.js";
import type { TestCase } from "./specs.js";
import type { ApiIndex } from "./spec.js";

export interface RunOptions {
  baseUrl: string;
  /** Extra headers for every case except "unauthorized" ones (e.g. Authorization). */
  authHeader?: { name: string; value: string };
  concurrency?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  index?: ApiIndex;
  onResult?: (result: CaseResult) => void;
}

export interface CaseResult {
  id: string;
  endpoint: string;
  method: string;
  description: string;
  passed: boolean;
  status: number | null;
  latencyMs: number;
  /** Each failed assertion, e.g. "expected status 200, got 500". */
  failures: string[];
  /** The start of the response body, for failing cases. */
  bodySnippet?: string;
}

export interface RunReport {
  baseUrl: string;
  startedAt: string;
  total: number;
  passed: number;
  failed: number;
  latency: { min: number; p50: number; p95: number; max: number; mean: number };
  results: CaseResult[];
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Parses "Name: value" (as given to --auth-header or MOFU_API_AUTH). */
export function parseAuthHeader(
  raw: string | undefined,
): { name: string; value: string } | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^([A-Za-z0-9-]+):\s*(.+)$/);
  if (!m) throw new Error('The auth header must look like "Authorization: Bearer <token>".');
  return { name: m[1]!, value: m[2]! };
}

/** Whether the target is this machine or a private network (safe to hammer) or a public host. */
export async function classifyTarget(
  baseUrl: string,
  resolve?: Resolver,
): Promise<{ host: string; local: boolean }> {
  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost)$/i.test(host)) return { host, local: true };
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  const addresses = literal
    ? [host]
    : await (resolve ? resolve(host).catch(() => []) : Promise.resolve([]));
  return { host, local: addresses.length > 0 && addresses.every(isPrivateAddress) };
}

async function runCase(
  c: TestCase,
  opts: Required<Pick<RunOptions, "baseUrl" | "timeoutMs">> & RunOptions,
): Promise<CaseResult> {
  const failures: string[] = [];
  const headers: Record<string, string> = { ...c.request.headers };
  if (
    c.request.body !== undefined &&
    !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
  ) {
    headers["content-type"] = "application/json";
  }
  if (opts.authHeader && c.category !== "unauthorized")
    headers[opts.authHeader.name] = opts.authHeader.value;
  const fetchFn = opts.fetchFn ?? fetch;
  const started = performance.now();
  let status: number | null = null;
  let text = "";
  try {
    const res = await fetchFn(buildRequestUrl(opts.baseUrl, c), {
      method: c.method.toUpperCase(),
      headers,
      body: c.request.body === undefined ? undefined : JSON.stringify(c.request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    failures.push(
      name === "TimeoutError" || name === "AbortError"
        ? `timed out after ${opts.timeoutMs} ms`
        : `request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const latencyMs = Math.round(performance.now() - started);

  if (status !== null) {
    if (status !== c.expect.status)
      failures.push(`expected status ${c.expect.status}, got ${status}`);
    // Body assertions describe the expected status's body; after a status mismatch they only add noise.
    const m = status === c.expect.status ? c.expect.bodyMatches : undefined;
    if (m?.keys?.length || m?.equals || m?.responseSchema) {
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        failures.push("expected a JSON body");
      }
      if (json !== undefined) {
        for (const k of m.keys ?? [])
          if (getPath(json, k) === undefined) failures.push(`body is missing ${k}`);
        for (const [k, v] of Object.entries(m.equals ?? {})) {
          const got = getPath(json, k);
          if (JSON.stringify(got) !== JSON.stringify(v))
            failures.push(`body ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
        }
        if (m.responseSchema && opts.index) {
          const endpoint = opts.index.endpoints.find(
            (e) => e.key === `${c.method.toUpperCase()} ${c.endpoint}`,
          );
          const schema = endpoint?.responses.find((r) => r.status === String(status))?.schema;
          if (schema)
            failures.push(
              ...schemaErrors(schema, json).map((e) => `body doesn't match the spec at ${e}`),
            );
        }
      }
    }
  }
  if (c.expect.maxLatencyMs && latencyMs > c.expect.maxLatencyMs)
    failures.push(`took ${latencyMs} ms (limit ${c.expect.maxLatencyMs} ms)`);
  return {
    id: c.id,
    endpoint: c.endpoint,
    method: c.method.toUpperCase(),
    description: c.description,
    passed: failures.length === 0,
    status,
    latencyMs,
    failures,
    ...(failures.length && text && { bodySnippet: text.slice(0, 300) }),
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
    : 0;

/** Runs every case with a concurrency limit; results keep the suite order. */
export async function runSuite(cases: TestCase[], options: RunOptions): Promise<RunReport> {
  const opts = { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const limit = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 16));
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const startedAt = new Date().toISOString();
  await Promise.all(
    Array.from({ length: Math.min(limit, cases.length) }, async () => {
      while (next < cases.length) {
        const i = next++;
        results[i] = await runCase(cases[i]!, opts);
        options.onResult?.(results[i]!);
      }
    }),
  );
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const passed = results.filter((r) => r.passed).length;
  return {
    baseUrl: options.baseUrl,
    startedAt,
    total: results.length,
    passed,
    failed: results.length - passed,
    latency: {
      min: latencies[0] ?? 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.at(-1) ?? 0,
      mean: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
    },
    results,
  };
}

export function formatRunMarkdown(report: RunReport, title: string): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `# Test run: ${title}`,
    "",
    `Target: ${report.baseUrl} · ${report.startedAt}`,
    "",
    `**${report.passed}/${report.total} passed**, ${report.failed} failed. Latency: p50 ${report.latency.p50} ms, p95 ${report.latency.p95} ms, max ${report.latency.max} ms.`,
    "",
    "| Result | Test | Request | Status | ms | Failure |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| ${r.passed ? "✅ pass" : "❌ fail"} | ${esc(r.id)} | ${r.method} ${esc(r.endpoint)} | ${r.status ?? "—"} | ${r.latencyMs} | ${esc(r.failures.join("; "))} |`,
    ),
    "",
  ].join("\n");
}

/** Failures only, compact, for the model's summary. */
export function formatRunForModel(report: RunReport): string {
  const failed = report.results.filter((r) => !r.passed);
  return [
    `Test run against ${report.baseUrl}: ${report.passed}/${report.total} passed. Latency p50 ${report.latency.p50} ms, p95 ${report.latency.p95} ms.`,
    ...(failed.length ? ["Failures (from code, exact):"] : ["No failures."]),
    ...failed.map(
      (r) =>
        `- ${r.id} (${r.method} ${r.endpoint}, ${r.description}): ${r.failures.join("; ")}${r.bodySnippet ? ` | body: ${r.bodySnippet.slice(0, 200)}` : ""}`,
    ),
  ].join("\n");
}

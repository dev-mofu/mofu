/**
 * Generated API test cases: the schema the model must follow, code checks
 * against the spec (so only invalid cases are regenerated), and exports.
 */
import { Validator } from "@cfworker/json-schema";
import { z } from "zod";
import { TestCaseSchema, type TestCase } from "./specs.js";
import { trimSchema, type ApiIndex, type Endpoint, type Schema } from "./spec.js";

export interface TestSuite {
  title: string;
  /** The spec version the cases were generated from. */
  apiVersion: string;
  cases: TestCase[];
}

export interface CaseProblem {
  id: string;
  problems: string[];
}

const keyOf = (c: Pick<TestCase, "method" | "endpoint">) =>
  `${c.method.toUpperCase()} ${c.endpoint}`;

function validatorFor(schema: Schema): Validator {
  return new Validator(trimSchema(schema, 8) as Schema, "2020-12", false);
}

/** Validates `value` against a spec schema; returns readable errors (empty when valid). */
export function schemaErrors(schema: Schema, value: unknown): string[] {
  const result = validatorFor(schema).validate(value);
  if (result.valid) return [];
  // The innermost errors are the useful ones; cfworker lists parents first.
  const leaves = result.errors.filter(
    (e) => !/^(properties|items|allOf|anyOf|oneOf|\$ref)$/.test(e.keyword),
  );
  const list = (leaves.length ? leaves : result.errors).map(
    (e) => `${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`,
  );
  return [...new Set(list)].slice(0, 6);
}

function documented(endpoint: Endpoint, status: number): boolean {
  return endpoint.responses.some(
    (r) =>
      r.status === String(status) ||
      r.status === `${String(status)[0]}XX` ||
      r.status === "default",
  );
}

/**
 * Checks generated cases against the spec. Happy-path bodies must match the
 * request schema; every case must target a real endpoint and a documented status.
 */
export function checkCases(
  cases: TestCase[],
  index: ApiIndex,
  existingIds: Iterable<string> = [],
): { valid: TestCase[]; invalid: CaseProblem[] } {
  const byKey = new Map(index.endpoints.map((e) => [e.key, e]));
  const ids = new Set(existingIds);
  const valid: TestCase[] = [];
  const invalid: CaseProblem[] = [];
  for (const c of cases) {
    const problems: string[] = [];
    const endpoint = byKey.get(keyOf(c));
    if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    if (!endpoint) {
      problems.push(`${keyOf(c)} isn't in the spec`);
    } else {
      for (const name of endpoint.path.match(/\{([^}]+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
        if (!(name in c.request.pathParams)) problems.push(`missing path parameter ${name}`);
      }
      if (!documented(endpoint, c.expect.status)) {
        problems.push(
          `status ${c.expect.status} isn't documented for ${endpoint.key} (documented: ${endpoint.responses.map((r) => r.status).join(", ")})`,
        );
      }
      if (c.category === "unauthorized" && !endpoint.security.length)
        problems.push("the endpoint needs no auth, so an unauthorized case can't be tested");
      if (c.category === "happy_path") {
        if (c.expect.status >= 400)
          problems.push("a happy-path case should expect a success status");
        for (const p of endpoint.parameters) {
          if (p.in === "query" && p.required && !(p.name in c.request.query))
            problems.push(`missing required query parameter ${p.name}`);
          if (
            p.in === "header" &&
            p.required &&
            !Object.keys(c.request.headers).some((h) => h.toLowerCase() === p.name.toLowerCase())
          ) {
            problems.push(`missing required header ${p.name}`);
          }
        }
        if (endpoint.requestBody) {
          if (c.request.body === undefined) {
            if (endpoint.requestBody.required) problems.push("missing the required request body");
          } else {
            problems.push(
              ...schemaErrors(endpoint.requestBody.schema, c.request.body).map(
                (e) => `request body ${e}`,
              ),
            );
          }
        }
      }
    }
    if (problems.length) invalid.push({ id: c.id, problems });
    else {
      valid.push(c);
      ids.add(c.id);
    }
  }
  return { valid, invalid };
}

/** Builds the full URL for a case. */
export function buildRequestUrl(baseUrl: string, c: TestCase): string {
  const path = c.endpoint.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(String(c.request.pathParams[name] ?? "")),
  );
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(c.request.query)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  return url.toString();
}

/** Reads "a.b[0].c" from a JSON value; `undefined` when missing. */
export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A deterministic example value for a schema (for docs). */
export function exampleFromSchema(schema: Schema | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length)
      return exampleFromSchema(options[0] as Schema, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...schema.allOf
        .map((s) => exampleFromSchema(s as Schema, depth + 1))
        .filter((v) => v && typeof v === "object"),
    );
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || (!type && schema.properties)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    return Object.fromEntries(
      Object.entries(props)
        .slice(0, 15)
        .map(([k, v]) => [k, exampleFromSchema(v, depth + 1)]),
    );
  }
  if (type === "array") return [exampleFromSchema(schema.items as Schema, depth + 1)];
  if (type === "integer") return typeof schema.minimum === "number" ? schema.minimum : 1;
  if (type === "number") return typeof schema.minimum === "number" ? schema.minimum : 1.5;
  if (type === "boolean") return true;
  if (type === "string") {
    const formats: Record<string, string> = {
      "date-time": "2026-01-15T09:30:00Z",
      date: "2026-01-15",
      email: "user@example.com",
      uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      uri: "https://example.com",
    };
    return formats[String(schema.format)] ?? "string";
  }
  return null;
}

// --- Exports -----------------------------------------------------------------

export function toSuiteJson(suite: TestSuite): string {
  return `${JSON.stringify({ title: suite.title, apiVersion: suite.apiVersion, generatedBy: "Mofu APIForge", cases: suite.cases }, null, 2)}\n`;
}

/** Reads a suite back (from toSuiteJson or a bare array of cases). */
export function parseSuiteJson(text: string): TestCase[] {
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data) ? data : (data as { cases?: unknown }).cases;
  return z.array(TestCaseSchema).parse(list);
}

/** A ready-to-run Vitest file: data-driven, plain fetch, no dependencies beyond vitest. */
export function toVitestFile(suite: TestSuite, defaultBaseUrl = "http://localhost:3000"): string {
  return `// Generated by Mofu APIForge from ${suite.title} ${suite.apiVersion}.
// Run: API_BASE_URL=${defaultBaseUrl} npx vitest run this-file.test.ts
// Optional auth: API_AUTH_HEADER="Authorization: Bearer <token>"
import { describe, expect, it } from "vitest";

const BASE_URL = (process.env.API_BASE_URL ?? ${JSON.stringify(defaultBaseUrl)}).replace(/\\/+$/, "");
const AUTH = process.env.API_AUTH_HEADER?.match(/^([^:]+):\\s*(.*)$/);

const cases = ${JSON.stringify(suite.cases, null, 2)};

function url(c: (typeof cases)[number]): string {
  const path = c.endpoint.replace(/\\{([^}]+)\\}/g, (_: string, n: string) => encodeURIComponent(String((c.request.pathParams as Record<string, unknown>)[n] ?? "")));
  const u = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(c.request.query as Record<string, unknown>)) {
    for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(item));
  }
  return u.toString();
}

function get(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.match(/[^.[\\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe(${JSON.stringify(suite.title)}, () => {
  for (const c of cases) {
    it(\`\${c.id}: \${c.description}\`, async () => {
      const body = (c.request as { body?: unknown }).body;
      const headers: Record<string, string> = { ...(c.request.headers as Record<string, string>) };
      if (body !== undefined) headers["content-type"] ??= "application/json";
      if (AUTH && c.category !== "unauthorized") headers[AUTH[1]!] = AUTH[2]!;
      const started = Date.now();
      const res = await fetch(url(c), { method: c.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(c.expect.status);
      const matches = (c.expect as { bodyMatches?: { keys?: string[]; equals?: Record<string, unknown> } }).bodyMatches;
      if (matches?.keys || matches?.equals) {
        const json = await res.json();
        for (const k of matches.keys ?? []) expect(get(json, k), k).not.toBeUndefined();
        for (const [k, v] of Object.entries(matches.equals ?? {})) expect(get(json, k), k).toEqual(v);
      }
      const limit = (c.expect as { maxLatencyMs?: number }).maxLatencyMs;
      if (limit) expect(elapsed).toBeLessThanOrEqual(limit);
    });
  }
});
`;
}

/** A .http file for the VS Code REST Client / JetBrains HTTP client. */
export function toHttpFile(suite: TestSuite, defaultBaseUrl = "http://localhost:3000"): string {
  const blocks = suite.cases.map((c) => {
    const full = new URL(buildRequestUrl("http://placeholder.invalid", c));
    const url = `{{baseUrl}}${full.pathname}${full.search}`;
    const headers = {
      ...c.request.headers,
      ...(c.request.body !== undefined && { "Content-Type": "application/json" }),
    };
    return [
      `### ${c.id}: ${c.description} (expect ${c.expect.status})`,
      `${c.method.toUpperCase()} ${url}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ...(c.category !== "unauthorized" ? ["# Authorization: {{auth}}"] : []),
      ...(c.request.body !== undefined ? ["", JSON.stringify(c.request.body, null, 2)] : []),
    ].join("\n");
  });
  return `# Generated by Mofu APIForge from ${suite.title} ${suite.apiVersion}\n@baseUrl = ${defaultBaseUrl}\n\n${blocks.join("\n\n")}\n`;
}

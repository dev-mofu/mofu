/**
 * OpenAPI/Swagger loading for APIForge. Web-safe (browser, Node; no node: APIs).
 * Every spec is validated, upgraded to OpenAPI 3.1 and dereferenced, so the
 * rest of the code only deals with one shape.
 */
import { dereference, upgrade, validate } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";

import { HTTP_METHODS, type HttpMethod } from "./specs.js";

/** A JSON Schema fragment (OpenAPI 3.1 schemas are JSON Schema 2020-12). */
export type Schema = Record<string, unknown>;

export interface SpecProblem {
  /** JSON pointer into the original document, e.g. /paths/~1pets/get. Empty when unknown. */
  path: string;
  message: string;
}

export interface EndpointParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  type: string;
  description?: string;
  schema: Schema;
}

export interface EndpointResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: Schema;
}

export interface Endpoint {
  /** "GET /pets/{id}": the key used everywhere (tests, docs, diff). */
  key: string;
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: EndpointParameter[];
  requestBody?: { required: boolean; contentType: string; schema: Schema };
  responses: EndpointResponse[];
  /** Alternatives (OR) of scheme sets (AND). Empty array = explicitly public; inherited from the root when absent. */
  security: string[][];
}

export interface ApiIndex {
  title: string;
  version: string;
  /** The version of the uploaded document, before upgrading. */
  specVersion: string;
  servers: string[];
  securitySchemes: Record<string, string>;
  endpoints: Endpoint[];
}

export type LoadedSpec =
  { ok: true; index: ApiIndex; warnings: SpecProblem[] } | { ok: false; problems: SpecProblem[] };

export const MAX_SPEC_CHARS = 2_000_000;

function parseText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return parseYaml(trimmed, { maxAliasCount: 100 });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A short type label for tables: "integer", "string (date-time)", "array of Pet", "string enum". */
export function typeLabel(schema: Schema | undefined): string {
  if (!schema) return "any";
  const t = schema.type;
  const types = Array.isArray(t) ? t.filter((x) => x !== "null") : t ? [t] : [];
  if (schema.enum) return `${types[0] ?? "value"} enum`;
  if (types[0] === "array") {
    const items = isObject(schema.items) ? (schema.items as Schema) : undefined;
    return `array of ${items?.title ?? typeLabel(items)}`;
  }
  if (!types.length) {
    if (schema.oneOf || schema.anyOf) return "one of several";
    if (schema.allOf) return "object";
    if (schema.properties) return "object";
    return "any";
  }
  const base = String(types[0]);
  return schema.format ? `${base} (${String(schema.format)})` : base;
}

function pickContent(content: unknown): { contentType: string; schema?: Schema } | undefined {
  if (!isObject(content)) return undefined;
  const types = Object.keys(content);
  const contentType = types.find((t) => /json/i.test(t)) ?? types[0];
  if (!contentType) return undefined;
  const media = content[contentType];
  return {
    contentType,
    ...(isObject(media) && isObject(media.schema) && { schema: media.schema as Schema }),
  };
}

function securityOf(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObject).map((req) => Object.keys(req).sort());
}

/** Builds the endpoint index from a dereferenced OpenAPI 3.1 document. */
export function buildIndex(doc: Record<string, unknown>, specVersion: string): ApiIndex {
  const info = isObject(doc.info) ? doc.info : {};
  const rootSecurity = securityOf(doc.security) ?? [];
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const endpoints: Endpoint[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters.filter(isObject) : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      // Operation parameters override path-level ones with the same name and location.
      const own = Array.isArray(op.parameters) ? op.parameters.filter(isObject) : [];
      const merged = new Map<string, Record<string, unknown>>();
      for (const p of [...shared, ...own]) merged.set(`${String(p.in)}:${String(p.name)}`, p);
      const parameters: EndpointParameter[] = [...merged.values()].map((p) => {
        const schema = isObject(p.schema) ? (p.schema as Schema) : {};
        return {
          name: String(p.name),
          in: String(p.in) as EndpointParameter["in"],
          required: p.in === "path" || p.required === true,
          type: typeLabel(schema),
          ...(typeof p.description === "string" && { description: p.description }),
          schema,
        };
      });
      const body = isObject(op.requestBody) ? op.requestBody : undefined;
      const bodyContent = body ? pickContent(body.content) : undefined;
      const responses: EndpointResponse[] = Object.entries(
        isObject(op.responses) ? op.responses : {},
      )
        .filter(([, r]) => isObject(r))
        .map(([status, r]) => {
          const res = r as Record<string, unknown>;
          const content = pickContent(res.content);
          return {
            status,
            ...(typeof res.description === "string" && { description: res.description }),
            ...(content?.contentType && { contentType: content.contentType }),
            ...(content?.schema && { schema: content.schema }),
          };
        });
      const upper = method.toUpperCase();
      endpoints.push({
        key: `${upper} ${path}`,
        method,
        path,
        ...(typeof op.operationId === "string" && { operationId: op.operationId }),
        ...(typeof op.summary === "string" && { summary: op.summary }),
        ...(typeof op.description === "string" && { description: op.description }),
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ["default"],
        deprecated: op.deprecated === true,
        parameters,
        ...(bodyContent && {
          requestBody: {
            required: body?.required === true,
            contentType: bodyContent.contentType,
            schema: bodyContent.schema ?? {},
          },
        }),
        responses,
        security: securityOf(op.security) ?? rootSecurity,
      });
    }
  }
  return {
    title: typeof info.title === "string" ? info.title : "API",
    version: typeof info.version === "string" ? info.version : "",
    specVersion,
    servers: Array.isArray(doc.servers)
      ? doc.servers.filter(isObject).map((s) => String(s.url))
      : [],
    securitySchemes: Object.fromEntries(
      Object.entries(schemes)
        .filter(([, s]) => isObject(s))
        .map(([name, s]) => {
          const scheme = s as Record<string, unknown>;
          const detail =
            scheme.type === "http"
              ? `http ${String(scheme.scheme ?? "")}`
              : scheme.type === "apiKey"
                ? `apiKey in ${String(scheme.in)} (${String(scheme.name)})`
                : String(scheme.type);
          return [name, detail.trim()];
        }),
    ),
    endpoints,
  };
}

/** Parses, validates, upgrades and dereferences a spec (JSON or YAML text, or an object). */
export async function loadSpec(input: string | Record<string, unknown>): Promise<LoadedSpec> {
  if (typeof input === "string" && input.length > MAX_SPEC_CHARS) {
    return {
      ok: false,
      problems: [{ path: "", message: `The spec is over ${MAX_SPEC_CHARS / 1e6} MB.` }],
    };
  }
  let raw: unknown;
  try {
    raw = typeof input === "string" ? parseText(input) : input;
  } catch (err) {
    return {
      ok: false,
      problems: [
        {
          path: "",
          message: `Not valid JSON or YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  if (!isObject(raw))
    return {
      ok: false,
      problems: [{ path: "", message: "The spec must be a JSON or YAML object." }],
    };
  const specVersion =
    typeof raw.openapi === "string"
      ? raw.openapi
      : typeof raw.swagger === "string"
        ? raw.swagger
        : "";
  if (!/^(2\.0|3\.[01])/.test(specVersion)) {
    return {
      ok: false,
      problems: [
        {
          path: "",
          message:
            "Not an OpenAPI 3.0/3.1 or Swagger 2.0 document (no openapi or swagger version field).",
        },
      ],
    };
  }
  const checked = await validate(raw as Record<string, unknown>);
  const problems: SpecProblem[] = (checked.errors ?? []).map((e) => ({
    path: (e as { path?: string }).path ?? "",
    message: e.message ?? String(e),
  }));
  if (!checked.valid) return { ok: false, problems };
  const upgraded = upgrade(raw as Record<string, unknown>).specification as unknown as Record<
    string,
    unknown
  >;
  const result = dereference(upgraded);
  if (result.errors?.length) {
    return { ok: false, problems: result.errors.map((e) => ({ path: "", message: e.message })) };
  }
  const index = buildIndex(result.schema as Record<string, unknown>, specVersion);
  const warnings: SpecProblem[] = [];
  if (!index.endpoints.length)
    warnings.push({ path: "/paths", message: "The spec defines no operations." });
  if (!index.version) warnings.push({ path: "/info/version", message: "info.version is missing." });
  return { ok: true, index, warnings };
}

/**
 * A copy of a schema small enough for a prompt or a validator: cycles are cut,
 * depth is limited, and long descriptions/examples are trimmed.
 */
export function trimSchema(schema: unknown, maxDepth = 5): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (Array.isArray(value)) return value.slice(0, 25).map((v) => walk(v, depth));
    if (!isObject(value))
      return typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value;
    if (seen.has(value)) return { description: "(recursive)" };
    if (depth > maxDepth) return { description: "(nested object omitted)" };
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "xml" || k === "externalDocs" || k.startsWith("x-")) continue;
      out[k] = walk(
        v,
        k === "properties" || k === "items" || k === "allOf" || k === "oneOf" || k === "anyOf"
          ? depth + 1
          : depth,
      );
    }
    seen.delete(value);
    return out;
  };
  return walk(schema, 0);
}

/** Groups endpoints by their first tag, keeping spec order. */
export function groupByTag(index: ApiIndex): Map<string, Endpoint[]> {
  const groups = new Map<string, Endpoint[]>();
  for (const e of index.endpoints) {
    const tag = e.tags[0] ?? "default";
    groups.set(tag, [...(groups.get(tag) ?? []), e]);
  }
  return groups;
}

/** A compact, prompt-sized list of every endpoint (no schemas). */
export function formatIndexForModel(index: ApiIndex, maxChars = 8_000): string {
  const lines = [
    `# ${index.title} ${index.version} (uploaded as ${index.specVersion.startsWith("2") ? "Swagger" : "OpenAPI"} ${index.specVersion})`,
    `Servers: ${index.servers.join(", ") || "none listed"}`,
    `Security schemes: ${
      Object.entries(index.securitySchemes)
        .map(([k, v]) => `${k} = ${v}`)
        .join("; ") || "none"
    }`,
    "",
  ];
  for (const [tag, endpoints] of groupByTag(index)) {
    lines.push(`## Group "${tag}" (${endpoints.length})`);
    for (const e of endpoints) {
      const auth = e.security.length
        ? ` [auth: ${e.security.map((s) => s.join("+")).join(" or ")}]`
        : "";
      lines.push(
        `- ${e.key}${e.summary ? ` — ${e.summary}` : ""} → ${e.responses.map((r) => r.status).join(", ")}${auth}${e.deprecated ? " (deprecated)" : ""}`,
      );
    }
    if (lines.join("\n").length > maxChars) {
      lines.push("- … (more groups omitted)");
      break;
    }
  }
  return lines.join("\n");
}

/** Full detail for one group, with trimmed schemas, for test or docs generation. */
export function formatGroupForModel(
  index: ApiIndex,
  tag: string,
  maxChars = 14_000,
): string | null {
  const endpoints = groupByTag(index).get(tag);
  if (!endpoints) return null;
  const detail = endpoints.map((e) => ({
    endpoint: e.key,
    ...(e.operationId && { operationId: e.operationId }),
    ...(e.summary && { summary: e.summary }),
    ...(e.description && { description: e.description.slice(0, 400) }),
    parameters: e.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      schema: trimSchema(p.schema, 2),
    })),
    ...(e.requestBody && {
      requestBody: {
        required: e.requestBody.required,
        contentType: e.requestBody.contentType,
        schema: trimSchema(e.requestBody.schema),
      },
    }),
    responses: e.responses.map((r) => ({
      status: r.status,
      ...(r.description && { description: r.description }),
      ...(r.schema && { schema: trimSchema(r.schema, 3) }),
    })),
    security: e.security,
  }));
  const text = JSON.stringify(detail, null, 1);
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (truncated; the group is large)`
    : text;
}

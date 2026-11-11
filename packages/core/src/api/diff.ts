/**
 * Breaking-change detection between two API versions. Plain code: the model
 * explains the result but never decides what's breaking.
 */
import type { ApiIndex, Endpoint, Schema } from "./spec.js";

export type ChangeRule =
  | "endpoint-removed"
  | "endpoint-added"
  | "response-removed"
  | "response-added"
  | "parameter-added-required"
  | "parameter-added"
  | "parameter-became-required"
  | "parameter-became-optional"
  | "parameter-removed"
  | "body-became-required"
  | "field-added-required"
  | "field-added"
  | "field-became-required"
  | "field-removed"
  | "type-changed"
  | "enum-narrowed"
  | "enum-widened"
  | "security-changed"
  | "deprecated";

export interface SpecChange {
  breaking: boolean;
  rule: ChangeRule;
  endpoint: string;
  /** Where in the endpoint: "query parameter limit", "request body: owner.name", "response 200: tags[]". */
  location: string;
  message: string;
}

export interface SpecDiff {
  from: { title: string; version: string };
  to: { title: string; version: string };
  breaking: SpecChange[];
  nonBreaking: SpecChange[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Merges allOf members so properties and required lists can be compared. */
function flatten(schema: Schema | undefined, depth = 0): Schema {
  if (!schema || depth > 4) return schema ?? {};
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: Schema = {
    ...schema,
    properties: { ...(schema.properties as object) },
    required: [...((schema.required as string[]) ?? [])],
  };
  delete merged.allOf;
  for (const part of schema.allOf) {
    if (!isObject(part)) continue;
    const flat = flatten(part as Schema, depth + 1);
    Object.assign(merged.properties as object, flat.properties ?? {});
    (merged.required as string[]).push(...((flat.required as string[]) ?? []));
    if (flat.type && !merged.type) merged.type = flat.type;
  }
  return merged;
}

function typeSet(schema: Schema): string[] {
  const t = schema.type;
  const list = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
  // "integer" is a subset of "number": treat number as covering integer for widening checks.
  return list.filter((x) => x !== "null").sort();
}

type Side = "request" | "response";

interface Ctx {
  endpoint: string;
  side: Side;
  /** "request body", "response 200", "query parameter limit" */
  where: string;
  out: SpecChange[];
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const subset = (a: string[], b: string[]) =>
  a.every((x) => b.includes(x) || (x === "integer" && b.includes("number")));

function push(ctx: Ctx, breaking: boolean, rule: ChangeRule, field: string, message: string) {
  ctx.out.push({
    breaking,
    rule,
    endpoint: ctx.endpoint,
    location: field ? `${ctx.where}: ${field}` : ctx.where,
    message,
  });
}

/** Compares two schemas at `field` (dot path; "" for the root). */
function compareSchema(
  oldS: Schema | undefined,
  newS: Schema | undefined,
  ctx: Ctx,
  field: string,
  depth = 0,
): void {
  if (!oldS || !newS || depth > 6) return;
  const a = flatten(oldS);
  const b = flatten(newS);
  // At the root (a parameter, or the whole body) the location is just ctx.where.
  const label = field;

  const ta = typeSet(a);
  const tb = typeSet(b);
  if (ta.length && tb.length && !sameSet(ta, tb)) {
    // Accepting more types is fine for requests; returning fewer is fine for responses.
    const harmless = ctx.side === "request" ? subset(ta, tb) : subset(tb, ta);
    push(
      ctx,
      !harmless,
      "type-changed",
      label,
      `type changed from ${ta.join("|")} to ${tb.join("|")}`,
    );
  }

  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    const oldValues = (a.enum as unknown[]).map((v) => JSON.stringify(v));
    const newValues = (b.enum as unknown[]).map((v) => JSON.stringify(v));
    const removed = oldValues
      .filter((v) => !newValues.includes(v))
      .map((v) => JSON.parse(v) as unknown);
    const added = newValues
      .filter((v) => !oldValues.includes(v))
      .map((v) => JSON.parse(v) as unknown);
    if (removed.length) {
      // Fewer accepted values breaks requests; responses returning fewer values is safe.
      push(
        ctx,
        ctx.side === "request",
        "enum-narrowed",
        label,
        `enum no longer allows ${removed.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    }
    if (added.length) {
      // New values in a response can break clients that switch over the old ones.
      push(
        ctx,
        ctx.side === "response",
        "enum-widened",
        label,
        `enum now also allows ${added.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    }
  } else if (!Array.isArray(a.enum) && Array.isArray(b.enum) && ctx.side === "request") {
    push(
      ctx,
      true,
      "enum-narrowed",
      label,
      `now limited to ${b.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }

  const pa = isObject(a.properties) ? a.properties : {};
  const pb = isObject(b.properties) ? b.properties : {};
  const ra = new Set(Array.isArray(a.required) ? a.required.map(String) : []);
  const rb = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
  const join = (name: string) => (field ? `${field}.${name}` : name);
  for (const name of Object.keys(pa)) {
    if (!(name in pb)) {
      if (ctx.side === "response")
        push(ctx, true, "field-removed", join(name), "field removed from the response");
      else
        push(ctx, false, "field-removed", join(name), "field no longer part of the request schema");
      continue;
    }
    if (ctx.side === "request" && !ra.has(name) && rb.has(name)) {
      push(ctx, true, "field-became-required", join(name), "field is now required");
    }
    compareSchema(pa[name] as Schema, pb[name] as Schema, ctx, join(name), depth + 1);
  }
  for (const name of Object.keys(pb)) {
    if (name in pa) continue;
    if (ctx.side === "request" && rb.has(name))
      push(ctx, true, "field-added-required", join(name), "new required field");
    else
      push(
        ctx,
        false,
        "field-added",
        join(name),
        ctx.side === "request" ? "new optional field" : "new field in the response",
      );
  }

  if (isObject(a.items) && isObject(b.items)) {
    compareSchema(a.items as Schema, b.items as Schema, ctx, `${field || ""}[]`, depth + 1);
  }
}

const securityKey = (s: string[][]) =>
  s
    .map((alt) => alt.join("+"))
    .sort()
    .join(" | ");

function compareEndpoint(a: Endpoint, b: Endpoint, out: SpecChange[]): void {
  const base = { endpoint: a.key, out };

  if (!a.deprecated && b.deprecated)
    out.push({
      breaking: false,
      rule: "deprecated",
      endpoint: a.key,
      location: "operation",
      message: "endpoint is now deprecated",
    });

  // Responses
  const statusesB = new Set(b.responses.map((r) => r.status));
  for (const r of a.responses) {
    if (!statusesB.has(r.status)) {
      out.push({
        breaking: true,
        rule: "response-removed",
        endpoint: a.key,
        location: `response ${r.status}`,
        message: `response ${r.status} removed`,
      });
      continue;
    }
    const rb = b.responses.find((x) => x.status === r.status)!;
    compareSchema(
      r.schema,
      rb.schema,
      { ...base, side: "response", where: `response ${r.status}` },
      "",
    );
  }
  for (const r of b.responses) {
    if (!a.responses.some((x) => x.status === r.status)) {
      out.push({
        breaking: false,
        rule: "response-added",
        endpoint: a.key,
        location: `response ${r.status}`,
        message: `new response ${r.status}`,
      });
    }
  }

  // Parameters
  const id = (p: { in: string; name: string }) => `${p.in}:${p.name.toLowerCase()}`;
  const paramsB = new Map(b.parameters.map((p) => [id(p), p]));
  for (const p of a.parameters) {
    const where = `${p.in} parameter ${p.name}`;
    const q = paramsB.get(id(p));
    if (!q) {
      out.push({
        breaking: false,
        rule: "parameter-removed",
        endpoint: a.key,
        location: where,
        message: "parameter removed (clients still sending it are usually ignored)",
      });
      continue;
    }
    if (!p.required && q.required)
      out.push({
        breaking: true,
        rule: "parameter-became-required",
        endpoint: a.key,
        location: where,
        message: "parameter is now required",
      });
    if (p.required && !q.required)
      out.push({
        breaking: false,
        rule: "parameter-became-optional",
        endpoint: a.key,
        location: where,
        message: "parameter is now optional",
      });
    compareSchema(p.schema, q.schema, { ...base, side: "request", where }, "");
  }
  for (const q of b.parameters) {
    if (a.parameters.some((p) => id(p) === id(q))) continue;
    const where = `${q.in} parameter ${q.name}`;
    if (q.required)
      out.push({
        breaking: true,
        rule: "parameter-added-required",
        endpoint: a.key,
        location: where,
        message: "new required parameter",
      });
    else
      out.push({
        breaking: false,
        rule: "parameter-added",
        endpoint: a.key,
        location: where,
        message: "new optional parameter",
      });
  }

  // Request body
  if (b.requestBody?.required && !a.requestBody?.required) {
    out.push({
      breaking: true,
      rule: "body-became-required",
      endpoint: a.key,
      location: "request body",
      message: a.requestBody ? "request body is now required" : "new required request body",
    });
  }
  if (a.requestBody && b.requestBody) {
    compareSchema(
      a.requestBody.schema,
      b.requestBody.schema,
      { ...base, side: "request", where: "request body" },
      "",
    );
  }

  // Security
  const sa = securityKey(a.security);
  const sb = securityKey(b.security);
  if (sa !== sb) {
    const nowPublic = b.security.length === 0;
    out.push({
      breaking: !nowPublic,
      rule: "security-changed",
      endpoint: a.key,
      location: "security",
      message: `security changed from ${sa || "none"} to ${sb || "none"}`,
    });
  }
}

/** Compares two indexed specs. */
export function diffSpecs(from: ApiIndex, to: ApiIndex): SpecDiff {
  const changes: SpecChange[] = [];
  const toByKey = new Map(to.endpoints.map((e) => [e.key, e]));
  const toPaths = new Set(to.endpoints.map((e) => e.path));
  for (const e of from.endpoints) {
    const match = toByKey.get(e.key);
    if (!match) {
      changes.push({
        breaking: true,
        rule: "endpoint-removed",
        endpoint: e.key,
        location: "operation",
        message: toPaths.has(e.path)
          ? `method ${e.method.toUpperCase()} removed from ${e.path}`
          : "endpoint removed",
      });
      continue;
    }
    compareEndpoint(e, match, changes);
  }
  const fromKeys = new Set(from.endpoints.map((e) => e.key));
  for (const e of to.endpoints) {
    if (!fromKeys.has(e.key))
      changes.push({
        breaking: false,
        rule: "endpoint-added",
        endpoint: e.key,
        location: "operation",
        message: "new endpoint",
      });
  }
  return {
    from: { title: from.title, version: from.version },
    to: { title: to.title, version: to.version },
    breaking: changes.filter((c) => c.breaking),
    nonBreaking: changes.filter((c) => !c.breaking),
  };
}

/** Markdown table of the diff (deterministic). */
export function formatDiffMarkdown(diff: SpecDiff): string {
  const row = (c: SpecChange) =>
    `| ${c.endpoint} | ${c.location.replace(/\|/g, "\\|")} | ${c.message.replace(/\|/g, "\\|")} |`;
  const table = (list: SpecChange[]) =>
    list.length
      ? ["| Endpoint | Where | Change |", "| --- | --- | --- |", ...list.map(row)].join("\n")
      : "_None._";
  return [
    `# API changes: ${diff.from.title} ${diff.from.version} → ${diff.to.version}`,
    "",
    `**${diff.breaking.length} breaking**, ${diff.nonBreaking.length} non-breaking.`,
    "",
    "## Breaking",
    "",
    table(diff.breaking),
    "",
    "## Non-breaking",
    "",
    table(diff.nonBreaking),
    "",
  ].join("\n");
}

/** Compact text for the model (the classification is already done). */
export function formatDiffForModel(diff: SpecDiff, maxChars = 10_000): string {
  const line = (c: SpecChange) => `- ${c.endpoint} · ${c.location}: ${c.message}`;
  const text = [
    `Spec diff ${diff.from.version || "old"} → ${diff.to.version || "new"} (classified by code; do not reclassify).`,
    `BREAKING (${diff.breaking.length}):`,
    ...diff.breaking.map(line),
    `NON-BREAKING (${diff.nonBreaking.length}):`,
    ...diff.nonBreaking.map(line),
  ].join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

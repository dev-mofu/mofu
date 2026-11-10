import { z } from "zod";
import { mapLimit, requestJson, type HttpOptions } from "./http.js";
import type { Ecosystem } from "./types.js";

// ---------- OSV (vulnerabilities) ----------

const OSV = "https://api.osv.dev/v1";
const BATCH_SIZE = 1000;
const MAX_PAGES = 5;

const BatchSchema = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string() })).optional(),
      next_page_token: z.string().optional(),
    }),
  ),
});

const EventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
  limit: z.string().optional(),
});

export const OsvVulnSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  details: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
  database_specific: z.object({ severity: z.string().optional() }).passthrough().optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }).optional(),
        ranges: z.array(z.object({ type: z.string(), events: z.array(EventSchema) })).optional(),
        versions: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type OsvVuln = z.infer<typeof OsvVulnSchema>;
export type OsvAffected = NonNullable<OsvVuln["affected"]>[number];

export interface OsvQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

/** Vulnerability IDs affecting each query, in query order. One request per 1000 packages. */
export async function queryOsvBatch(
  queries: OsvQuery[],
  opts: HttpOptions = {},
): Promise<string[][]> {
  const out: string[][] = [];
  for (let start = 0; start < queries.length; start += BATCH_SIZE) {
    const chunk = queries.slice(start, start + BATCH_SIZE);
    const body = (page?: Array<string | undefined>) => ({
      queries: chunk.map((q, i) => ({
        package: { name: q.name, ecosystem: q.ecosystem },
        version: q.version,
        ...(page?.[i] && { page_token: page[i] }),
      })),
    });
    const ids: string[][] = chunk.map(() => []);
    let tokens: Array<string | undefined> | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await requestJson(`${OSV}/querybatch`, BatchSchema, {
        ...opts,
        method: "POST",
        body: body(tokens),
      });
      if (!res) break;
      res.results.forEach((r, i) => ids[i]?.push(...(r.vulns ?? []).map((v) => v.id)));
      // Only some queries have more pages; the rest return nothing new on the next round.
      if (!res.results.some((r) => r.next_page_token)) break;
      tokens = res.results.map((r) => r.next_page_token);
    }
    out.push(...ids.map((list) => [...new Set(list)]));
  }
  return out;
}

export async function fetchOsvVulns(
  ids: string[],
  opts: HttpOptions = {},
  concurrency = 6,
): Promise<Map<string, OsvVuln>> {
  const found = await mapLimit(ids, concurrency, (id) =>
    requestJson(`${OSV}/vulns/${encodeURIComponent(id)}`, OsvVulnSchema, opts).catch(() => null),
  );
  const map = new Map<string, OsvVuln>();
  found.forEach((v) => v && map.set(v.id, v));
  return map;
}

// ---------- deps.dev (latest version, release dates, deprecation) ----------

const DEPS_DEV = "https://api.deps.dev/v3/systems";

const DepsDevSchema = z.object({
  versions: z.array(
    z.object({
      versionKey: z.object({ version: z.string() }),
      publishedAt: z.string().optional(),
      isDefault: z.boolean().optional(),
      isDeprecated: z.boolean().optional(),
    }),
  ),
});

export interface PackageInfo {
  /** The registry's default version (npm "latest" tag, PyPI newest release). */
  latest: string | null;
  /** Newest publish date of any version. */
  lastRelease: string | null;
  deprecated: Set<string>;
  versions: string[];
}

export async function fetchPackageInfo(
  ecosystem: Ecosystem,
  name: string,
  opts: HttpOptions = {},
): Promise<PackageInfo | null> {
  const system = ecosystem === "npm" ? "npm" : "pypi";
  const data = await requestJson(
    `${DEPS_DEV}/${system}/packages/${encodeURIComponent(name)}`,
    DepsDevSchema,
    opts,
  );
  if (!data) return null;
  const dates = data.versions
    .map((v) => v.publishedAt)
    .filter((d): d is string => Boolean(d))
    .sort();
  return {
    latest: data.versions.find((v) => v.isDefault)?.versionKey.version ?? null,
    lastRelease: dates.at(-1) ?? null,
    deprecated: new Set(
      data.versions.filter((v) => v.isDeprecated).map((v) => v.versionKey.version),
    ),
    versions: data.versions.map((v) => v.versionKey.version),
  };
}

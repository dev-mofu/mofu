import { z } from "zod";

export type Ecosystem = "npm" | "PyPI";

/** One dependency as found in a manifest or lockfile. */
export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** Exact version, when a lockfile or an exact pin says so. */
  version: string | null;
  /** What the manifest asked for, e.g. "^4.17.0" or ">=2.0". Empty for lockfile-only entries. */
  declared: string;
  /** Listed directly in a manifest (not only pulled in by another package). */
  direct: boolean;
  /** True when `version` came from a lockfile or an exact pin, not a guess from a range. */
  resolved: boolean;
  files: string[];
}

export interface ParseResult {
  dependencies: Dependency[];
  /** Things we skipped or approximated, said plainly for the report. */
  notes: string[];
}

export const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

const VulnerabilitySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()),
  summary: z.string(),
  severity: z.enum(SEVERITIES),
  /** CVSS base score when one was published. */
  score: z.number().nullable(),
  /** Smallest version that fixes this vulnerability for the installed version, if any. */
  fixedIn: z.string().nullable(),
  url: z.string(),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

export const BEHIND = ["none", "patch", "minor", "major", "unknown"] as const;

const FindingSchema = z.object({
  ecosystem: z.enum(["npm", "PyPI"]),
  name: z.string(),
  version: z.string().nullable(),
  declared: z.string(),
  direct: z.boolean(),
  resolved: z.boolean(),
  files: z.array(z.string()),
  vulnerabilities: z.array(VulnerabilitySchema),
  worstSeverity: z.enum(SEVERITIES).nullable(),
  /** Smallest version that fixes every known vulnerability; null if none is published. */
  fixVersion: z.string().nullable(),
  fixIsMajor: z.boolean(),
  latest: z.string().nullable(),
  behind: z.enum(BEHIND),
  /** Releases newer than the installed version. */
  newerReleases: z.number().nullable(),
  latestIsMajor: z.boolean(),
  deprecated: z.boolean(),
  /** ISO date of the newest release on the registry. */
  lastRelease: z.string().nullable(),
  possiblyUnmaintained: z.boolean(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ScanReportSchema = z.object({
  generatedAt: z.string(),
  ecosystems: z.array(z.enum(["npm", "PyPI"])),
  files: z.array(z.string()),
  totals: z.object({
    dependencies: z.number(),
    direct: z.number(),
    vulnerablePackages: z.number(),
    vulnerabilities: z.number(),
    bySeverity: z.record(z.enum(SEVERITIES), z.number()),
    outdatedDirect: z.number(),
    majorBehind: z.number(),
    deprecated: z.number(),
    possiblyUnmaintained: z.number(),
  }),
  notes: z.array(z.string()),
  /** Only packages with at least one issue. */
  findings: z.array(FindingSchema),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

/** PEP 503 normalization; npm names are case-sensitive and kept as-is. */
export function normalizeName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

export const depKey = (d: Pick<Dependency, "ecosystem" | "name" | "version">) =>
  `${d.ecosystem}:${normalizeName(d.ecosystem, d.name)}@${d.version ?? "?"}`;

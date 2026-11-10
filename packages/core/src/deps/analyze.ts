import semver from "semver";
import type { OsvAffected, OsvVuln, PackageInfo } from "./sources.js";
import { behindLevel, compareVersions, isMajorJump } from "./versions.js";
import {
  depKey,
  normalizeName,
  SEVERITIES,
  type Dependency,
  type Ecosystem,
  type Finding,
  type ScanReport,
  type Severity,
  type Vulnerability,
} from "./types.js";

const UNMAINTAINED_MONTHS = 24;

// ---------- Severity ----------

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** CVSS v3.x base score from a vector string, per the FIRST specification. */
export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(
    vector
      .split("/")
      .slice(1)
      .map((p) => p.split(":") as [string, string]),
  );
  const scopeChanged = m.S === "C";
  const av = WEIGHTS.AV[m.AV as keyof typeof WEIGHTS.AV];
  const ac = WEIGHTS.AC[m.AC as keyof typeof WEIGHTS.AC];
  const ui = WEIGHTS.UI[m.UI as keyof typeof WEIGHTS.UI];
  const pr =
    m.PR === "N"
      ? 0.85
      : m.PR === "L"
        ? scopeChanged
          ? 0.68
          : 0.62
        : m.PR === "H"
          ? scopeChanged
            ? 0.5
            : 0.27
          : undefined;
  const [c, i, a] = [m.C, m.I, m.A].map((x) => WEIGHTS.CIA[x as keyof typeof WEIGHTS.CIA]);
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  // CVSS "round up" to one decimal, done in integers to avoid float error.
  const int = Math.round(raw * 100_000);
  return int % 10_000 === 0 ? int / 100_000 : (Math.floor(int / 10_000) + 1) / 10;
}

export function severityFromScore(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return score > 0 ? "low" : "unknown";
}

function severityOf(v: OsvVuln): { severity: Severity; score: number | null } {
  const vector = v.severity?.find((s) => s.type === "CVSS_V3")?.score;
  const score = vector ? cvss3BaseScore(vector) : null;
  const label = v.database_specific?.severity?.toLowerCase();
  const fromLabel: Severity | undefined =
    label === "critical"
      ? "critical"
      : label === "high"
        ? "high"
        : label === "moderate" || label === "medium"
          ? "moderate"
          : label === "low"
            ? "low"
            : undefined;
  return { severity: fromLabel ?? (score !== null ? severityFromScore(score) : "unknown"), score };
}

const rank = (s: Severity) => SEVERITIES.indexOf(s); // 0 = critical

// ---------- Affected ranges ----------

function entriesFor(v: OsvVuln, ecosystem: Ecosystem, name: string): OsvAffected[] {
  const want = normalizeName(ecosystem, name);
  return (v.affected ?? []).filter(
    (a) =>
      a.package &&
      a.package.ecosystem === ecosystem &&
      normalizeName(ecosystem, a.package.name) === want,
  );
}

/** Whether `version` falls in an affected range or the explicit version list. */
export function isAffected(entry: OsvAffected, ecosystem: Ecosystem, version: string): boolean {
  if (entry.versions?.includes(version)) return true;
  const gte = (a: string, b: string) => (compareVersions(ecosystem, a, b) ?? -1) >= 0;
  for (const range of entry.ranges ?? []) {
    if (range.type === "GIT") continue;
    let affected = false;
    for (const e of range.events) {
      if (e.introduced !== undefined && (e.introduced === "0" || gte(version, e.introduced)))
        affected = true;
      if (e.fixed !== undefined && gte(version, e.fixed)) affected = false;
      if (
        e.last_affected !== undefined &&
        (compareVersions(ecosystem, version, e.last_affected) ?? 0) > 0
      )
        affected = false;
    }
    if (affected) return true;
  }
  return false;
}

/** Smallest published fix above `version` for one affected entry, or null. */
function fixAbove(entry: OsvAffected, ecosystem: Ecosystem, version: string): string | null {
  const fixes = (entry.ranges ?? [])
    .flatMap((r) => r.events.map((e) => e.fixed))
    .filter(
      (f): f is string => f !== undefined && (compareVersions(ecosystem, f, version) ?? 0) > 0,
    )
    .sort((a, b) => compareVersions(ecosystem, a, b) ?? 0);
  return fixes[0] ?? null;
}

/** Smallest version that is not affected by any of the vulnerabilities, if one is known. */
export function fixVersionFor(
  vulns: OsvVuln[],
  ecosystem: Ecosystem,
  name: string,
  version: string,
): string | null {
  let candidate = version;
  // Each round moves past one more affected range; a handful of rounds settles it.
  for (let round = 0; round < 10; round++) {
    let moved = false;
    for (const v of vulns) {
      for (const entry of entriesFor(v, ecosystem, name)) {
        if (!isAffected(entry, ecosystem, candidate)) continue;
        const fix = fixAbove(entry, ecosystem, candidate);
        if (!fix) return null;
        candidate = fix;
        moved = true;
      }
    }
    if (!moved) return candidate === version ? null : candidate;
  }
  return null;
}

const isPrerelease = (ecosystem: Ecosystem, v: string) =>
  ecosystem === "npm" ? semver.prerelease(v) !== null : /(a|b|rc|dev)\d*$/i.test(v);

/**
 * The smallest fixing version can itself be a bad release (lodash 4.18.0 was
 * deprecated as "Bad release"). Move up to the first published version at or
 * above the fix that isn't deprecated, isn't a pre-release and isn't affected
 * by any of the vulnerabilities. Falls back to the minimal fix if none is known.
 */
export function safeRelease(
  fix: string,
  info: PackageInfo,
  vulns: OsvVuln[],
  d: Dependency,
): string {
  const candidates = info.versions
    .filter((v) => (compareVersions(d.ecosystem, v, fix) ?? -1) >= 0)
    .filter((v) => !info.deprecated.has(v) && !isPrerelease(d.ecosystem, v))
    .sort((a, b) => compareVersions(d.ecosystem, a, b) ?? 0);
  const clean = candidates.find((v) =>
    vulns.every((vuln) =>
      entriesFor(vuln, d.ecosystem, d.name).every((e) => !isAffected(e, d.ecosystem, v)),
    ),
  );
  return clean ?? fix;
}

/** OSV often lists the same issue under several IDs (GHSA, PYSEC, CVE). Keep one per alias group. */
function dedupeVulns(vulns: OsvVuln[]): OsvVuln[] {
  const kept: OsvVuln[] = [];
  const seen = new Set<string>();
  // Prefer GitHub advisories: they carry a severity label.
  const ordered = [...vulns].sort(
    (a, b) => Number(b.id.startsWith("GHSA")) - Number(a.id.startsWith("GHSA")),
  );
  for (const v of ordered) {
    const ids = [v.id, ...(v.aliases ?? [])];
    if (ids.some((id) => seen.has(id))) {
      ids.forEach((id) => seen.add(id));
      continue;
    }
    ids.forEach((id) => seen.add(id));
    kept.push(v);
  }
  return kept;
}

// ---------- Report ----------

export interface AnalyzeInput {
  dependencies: Dependency[];
  notes: string[];
  files: string[];
  /** Vulnerability IDs per dependency (depKey). */
  vulnIds: Map<string, string[]>;
  vulns: Map<string, OsvVuln>;
  /** Registry info per `${ecosystem}:${normalized name}`. */
  info: Map<string, PackageInfo | null>;
  now: Date;
}

export const infoKey = (ecosystem: Ecosystem, name: string) =>
  `${ecosystem}:${normalizeName(ecosystem, name)}`;

export function buildScanReport(input: AnalyzeInput): ScanReport {
  const cutoff = new Date(input.now);
  cutoff.setMonth(cutoff.getMonth() - UNMAINTAINED_MONTHS);
  const findings: Finding[] = [];
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;

  for (const d of input.dependencies) {
    const raw = (input.vulnIds.get(depKey(d)) ?? [])
      .map((id) => input.vulns.get(id))
      .filter((v): v is OsvVuln => Boolean(v));
    const vulns = dedupeVulns(raw);
    const vulnerabilities: Vulnerability[] = vulns
      .map((v) => {
        const { severity, score } = severityOf(v);
        const entry = d.version
          ? entriesFor(v, d.ecosystem, d.name).find((e) => isAffected(e, d.ecosystem, d.version!))
          : undefined;
        return {
          id: v.id,
          aliases: v.aliases ?? [],
          summary: (v.summary ?? v.details ?? "").split("\n")[0]?.slice(0, 200) ?? "",
          severity,
          score,
          fixedIn: entry && d.version ? fixAbove(entry, d.ecosystem, d.version) : null,
          url: `https://osv.dev/vulnerability/${v.id}`,
        };
      })
      .sort((a, b) => rank(a.severity) - rank(b.severity));
    vulnerabilities.forEach((v) => bySeverity[v.severity]++);

    const info = input.info.get(infoKey(d.ecosystem, d.name)) ?? null;
    const latest = info?.latest ?? null;
    const minimalFix =
      d.version && vulns.length ? fixVersionFor(vulns, d.ecosystem, d.name, d.version) : null;
    const fixVersion = minimalFix && info ? safeRelease(minimalFix, info, vulns, d) : minimalFix;
    const behind = d.version && latest ? behindLevel(d.ecosystem, d.version, latest) : "unknown";
    const newerReleases =
      d.version && info
        ? info.versions.filter(
            (v) =>
              (compareVersions(d.ecosystem, v, d.version!) ?? 0) > 0 &&
              !(d.ecosystem === "npm" && semver.prerelease(v)),
          ).length
        : null;
    const deprecated = info
      ? (d.version ? info.deprecated.has(d.version) : false) ||
        (latest !== null && info.deprecated.has(latest))
      : false;
    const possiblyUnmaintained = Boolean(info?.lastRelease && new Date(info.lastRelease) < cutoff);

    const outdated = d.direct && (behind === "major" || behind === "minor");
    if (!vulnerabilities.length && !deprecated && !possiblyUnmaintained && !outdated) continue;
    findings.push({
      ecosystem: d.ecosystem,
      name: d.name,
      version: d.version,
      declared: d.declared,
      direct: d.direct,
      resolved: d.resolved,
      files: d.files,
      vulnerabilities,
      worstSeverity: vulnerabilities[0]?.severity ?? null,
      fixVersion,
      fixIsMajor: Boolean(
        d.version && fixVersion && isMajorJump(d.ecosystem, d.version, fixVersion),
      ),
      latest,
      behind,
      newerReleases,
      latestIsMajor: behind === "major",
      deprecated,
      lastRelease: info?.lastRelease ?? null,
      possiblyUnmaintained,
    });
  }

  // Vulnerable packages first, worst severity first; then direct dependencies; then by name.
  const sortRank = (f: Finding) => (f.worstSeverity ? rank(f.worstSeverity) : SEVERITIES.length);
  findings.sort(
    (a, b) =>
      sortRank(a) - sortRank(b) ||
      Number(b.direct) - Number(a.direct) ||
      a.name.localeCompare(b.name),
  );

  return {
    generatedAt: input.now.toISOString(),
    ecosystems: [...new Set(input.dependencies.map((d) => d.ecosystem))],
    files: input.files,
    totals: {
      dependencies: input.dependencies.length,
      direct: input.dependencies.filter((d) => d.direct).length,
      vulnerablePackages: findings.filter((f) => f.vulnerabilities.length > 0).length,
      vulnerabilities: findings.reduce((n, f) => n + f.vulnerabilities.length, 0),
      bySeverity,
      outdatedDirect: findings.filter(
        (f) => f.direct && (f.behind === "major" || f.behind === "minor"),
      ).length,
      majorBehind: findings.filter((f) => f.direct && f.behind === "major").length,
      deprecated: findings.filter((f) => f.deprecated).length,
      possiblyUnmaintained: findings.filter((f) => f.possiblyUnmaintained).length,
    },
    notes: input.notes,
    findings,
  };
}

import type { Finding, ScanReport } from "./types.js";

const MAX_MODEL_CHARS = 14_000;
const MAX_VULNS_PER_PACKAGE = 6;

function versionLine(f: Finding): string {
  const parts = [
    f.version
      ? `${f.version}${f.resolved ? "" : " (lowest allowed by range, no lockfile)"}`
      : "version unknown",
    f.direct ? `direct${f.declared ? `, declared "${f.declared}"` : ""}` : "transitive",
  ];
  return parts.join("; ");
}

function findingForModel(f: Finding): string {
  const lines = [`- ${f.ecosystem} ${f.name} ${versionLine(f)}`];
  for (const v of f.vulnerabilities.slice(0, MAX_VULNS_PER_PACKAGE)) {
    const aliases = v.aliases.length ? ` (${v.aliases.slice(0, 3).join(", ")})` : "";
    const score = v.score !== null ? ` CVSS ${v.score}` : "";
    lines.push(
      `  - ${v.severity}${score}: ${v.id}${aliases}, fixed in ${v.fixedIn ?? "no published fix"}: ${v.summary}`,
    );
  }
  if (f.vulnerabilities.length > MAX_VULNS_PER_PACKAGE) {
    lines.push(`  - …and ${f.vulnerabilities.length - MAX_VULNS_PER_PACKAGE} more`);
  }
  const facts = [
    f.vulnerabilities.length
      ? `fixes all known vulnerabilities: ${f.fixVersion ?? "no single fixed version"}${f.fixIsMajor ? " (MAJOR version jump)" : ""}`
      : null,
    f.latest
      ? `latest ${f.latest} (${f.behind} behind${f.newerReleases !== null ? `, ${f.newerReleases} newer releases` : ""})`
      : null,
    f.deprecated ? "DEPRECATED" : null,
    f.possiblyUnmaintained
      ? `possibly unmaintained (last release ${f.lastRelease?.slice(0, 10)})`
      : null,
  ].filter(Boolean);
  if (facts.length) lines.push(`  ${facts.join("; ")}`);
  return lines.join("\n");
}

/** Compact text for the model: totals, notes and only the packages with findings. */
export function formatScanForModel(report: ScanReport): string {
  const t = report.totals;
  const sev = Object.entries(t.bySeverity)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const head = [
    "# Dependency scan",
    `Files: ${report.files.join(", ")}`,
    `Totals: ${t.dependencies} dependencies (${t.direct} direct); ${t.vulnerabilities} vulnerabilities in ${t.vulnerablePackages} packages${sev ? ` (${sev})` : ""}; ${t.outdatedDirect} direct dependencies outdated (${t.majorBehind} a major version behind); ${t.deprecated} deprecated; ${t.possiblyUnmaintained} possibly unmaintained.`,
    ...(report.notes.length ? ["Notes:", ...report.notes.map((n) => `- ${n}`)] : []),
    "",
    "## Findings",
  ].join("\n");
  let body = "";
  let included = 0;
  for (const f of report.findings) {
    const block = `${findingForModel(f)}\n`;
    if (head.length + body.length + block.length > MAX_MODEL_CHARS) break;
    body += block;
    included++;
  }
  const rest = report.findings.length - included;
  return `${head}\n${body || "No issues found.\n"}${rest > 0 ? `…and ${rest} more packages with lower-priority findings.\n` : ""}`;
}

const escapeCell = (s: string) => s.replace(/\|/g, "\\|");

/** Downloadable Markdown report, rendered from the deterministic data only. */
export function formatScanMarkdown(report: ScanReport, summary?: string): string {
  const t = report.totals;
  const lines = [
    "# Dependency report",
    "",
    `Generated ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC by Mofu from ${report.files.join(", ")}.`,
    "",
    `- ${t.dependencies} dependencies (${t.direct} direct)`,
    `- ${t.vulnerabilities} known vulnerabilities in ${t.vulnerablePackages} packages: ${Object.entries(
      t.bySeverity,
    )
      .map(([s, n]) => `${n} ${s}`)
      .join(", ")}`,
    `- ${t.outdatedDirect} direct dependencies outdated, ${t.majorBehind} by a major version`,
    `- ${t.deprecated} deprecated, ${t.possiblyUnmaintained} possibly unmaintained (no release in 24 months)`,
    "",
  ];
  if (summary) lines.push("## Summary and plan", "", summary.trim(), "");
  lines.push(
    "## Findings",
    "",
    "| Package | Current | Fix | Latest | Severity | Vulnerabilities | Flags |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const f of report.findings) {
    const flags = [
      f.direct ? "direct" : "transitive",
      f.fixIsMajor ? "fix is major" : "",
      f.behind === "major" ? "major behind" : "",
      f.deprecated ? "deprecated" : "",
      f.possiblyUnmaintained ? "unmaintained?" : "",
    ].filter(Boolean);
    lines.push(
      `| ${escapeCell(`${f.ecosystem}:${f.name}`)} | ${f.version ?? "?"} | ${f.fixVersion ?? (f.vulnerabilities.length ? "none" : "")} | ${f.latest ?? "?"} | ${f.worstSeverity ?? ""} | ${f.vulnerabilities.map((v) => `[${v.id}](${v.url})`).join(", ")} | ${flags.join(", ")} |`,
    );
  }
  if (report.notes.length) lines.push("", "## Notes", "", ...report.notes.map((n) => `- ${n}`));
  lines.push(
    "",
    "Vulnerability data: [OSV](https://osv.dev). Release data: [deps.dev](https://deps.dev).",
  );
  return `${lines.join("\n")}\n`;
}

const ID_PATTERN =
  /\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d+|GO-\d{4}-\d+|OSV-\d{4}-\d+)\b/gi;
const VERSION_PATTERN =
  /(?<![\w.])v?\d+\.\d+(?:\.\d+)?(?:[-.]?(?:a|b|rc|alpha|beta|dev|post|pre)\.?\d*)?(?![\w.]*\d)/gi;

/**
 * Vulnerability IDs and versions in the model's text that the scan doesn't
 * contain. The UI flags them: the model must not invent these.
 */
export function findUnverifiedReferences(
  text: string,
  report: ScanReport,
): { ids: string[]; versions: string[] } {
  const knownIds = new Set<string>();
  const knownVersions = new Set<string>(["3.0", "3.1", "4.0"]); // CVSS versions
  for (const f of report.findings) {
    for (const v of [f.version, f.fixVersion, f.latest]) if (v) knownVersions.add(v);
    for (const m of f.declared.matchAll(/\d+(?:\.\d+)+/g)) knownVersions.add(m[0]);
    for (const v of f.vulnerabilities) {
      knownIds.add(v.id.toUpperCase());
      v.aliases.forEach((a) => knownIds.add(a.toUpperCase()));
      if (v.fixedIn) knownVersions.add(v.fixedIn);
      if (v.score !== null) knownVersions.add(String(v.score));
    }
  }
  const ids = [...new Set([...text.matchAll(ID_PATTERN)].map((m) => m[0].toUpperCase()))].filter(
    (id) => !knownIds.has(id),
  );
  const versions = [
    ...new Set([...text.matchAll(VERSION_PATTERN)].map((m) => m[0].replace(/^v/i, ""))),
  ].filter(
    (v) =>
      !knownVersions.has(v) &&
      !knownVersions.has(`${v}.0`) &&
      ![...knownVersions].some((k) => k.startsWith(`${v}.`)),
  );
  return { ids, versions };
}

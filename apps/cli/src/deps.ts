import { modelTarget } from "./target.js";
import pc from "picocolors";
import {
  buildSystemPrompt,
  createModel,
  DEPS_SUMMARY_SECTION,
  findUnverifiedReferences,
  formatScanForModel,
  runTurn,
  scanWorkspace,
  type Finding,
  type MofuError,
  type ScanReport,
  type Severity,
} from "@mofu/core";
import type { Printer } from "./ui.js";

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bold(pc.red(s)),
  high: pc.red,
  moderate: pc.yellow,
  low: pc.dim,
  unknown: pc.dim,
};

export async function scanCurrentDirectory(
  printer: Printer,
  quiet = false,
): Promise<ScanReport | null> {
  try {
    return await scanWorkspace(process.cwd(), {
      ...(!quiet && { onProgress: (m: string) => printer.line(pc.dim(m)) }),
    });
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function flags(f: Finding): string {
  return [
    f.direct ? "" : "transitive",
    f.fixIsMajor ? "fix is a major upgrade" : "",
    f.vulnerabilities.length && !f.fixVersion ? "no fix published" : "",
    f.behind === "major" ? "major behind" : f.behind === "minor" && f.direct ? "outdated" : "",
    f.deprecated ? "deprecated" : "",
    f.possiblyUnmaintained ? `no release since ${f.lastRelease?.slice(0, 7)}` : "",
    f.resolved ? "" : "version guessed (no lockfile)",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Compact, aligned table of findings. */
export function printScanReport(report: ScanReport, printer: Printer): void {
  const t = report.totals;
  printer.line();
  printer.line(
    pc.bold(
      `${t.dependencies} dependencies · ${t.vulnerabilities} vulnerabilities in ${t.vulnerablePackages} packages · ${t.outdatedDirect} outdated · ${t.deprecated} deprecated · ${t.possiblyUnmaintained} possibly unmaintained`,
    ),
  );
  if (report.findings.length === 0) {
    printer.line(pc.green("No known vulnerabilities or outdated direct dependencies."));
  } else {
    const rows = report.findings.map((f) => [
      `${f.name}`.slice(0, 32),
      f.version ?? "?",
      f.fixVersion ?? (f.vulnerabilities.length ? "none" : "-"),
      f.latest ?? "?",
      f.worstSeverity ? `${f.worstSeverity} (${f.vulnerabilities.length})` : "-",
      flags(f),
    ]);
    const header = ["Package", "Current", "Fix", "Latest", "Severity", "Notes"];
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );
    const fmt = (cells: string[]) =>
      cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
    printer.line();
    printer.line(pc.dim(fmt(header)));
    report.findings.forEach((f, i) => {
      const line = fmt(rows[i] ?? []);
      printer.line(f.worstSeverity ? SEVERITY_COLOR[f.worstSeverity](line) : line);
    });
  }
  if (report.notes.length) {
    printer.line();
    for (const n of report.notes) printer.line(pc.dim(`· ${n}`));
  }
}

/** One model call: risk summary and upgrade plan from the compact report. */
export async function summarizeScan(
  report: ScanReport,
  opts: { apiKey: string; model: string; printer: Printer },
): Promise<boolean> {
  const { printer } = opts;
  printer.line();
  try {
    const result = await runTurn({
      model: createModel({ apiKey: opts.apiKey, modelId: opts.model, ...modelTarget() }),
      instructions: buildSystemPrompt({ surface: "cli", modeSection: DEPS_SUMMARY_SECTION }),
      messages: [{ role: "user", content: formatScanForModel(report) }],
      tools: {},
      limits: { maxSteps: 1, maxOutputTokens: 1_500 },
      onEvent: (e) => e.type === "text-delta" && printer.write(e.text),
    });
    printer.newline();
    const unverified = findUnverifiedReferences(result.text, report);
    if (unverified.ids.length || unverified.versions.length) {
      printer.line(
        pc.yellow(
          `  Check these: they aren't in the scan data: ${[...unverified.ids, ...unverified.versions].join(", ")}`,
        ),
      );
    }
    printer.usage(result.usage, opts.model);
    return true;
  } catch (err) {
    printer.error((err as MofuError).message);
    return false;
  }
}

export function fixPrompt(report: ScanReport): string {
  return `Here's the dependency scan of this project:\n\n${formatScanForModel(report)}\nShow me the prioritized upgrade plan and ask which upgrades to apply.`;
}

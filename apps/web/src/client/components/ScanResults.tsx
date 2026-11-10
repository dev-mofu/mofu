import { useMemo, useState } from "react";
import {
  formatScanMarkdown,
  SEVERITIES,
  type Finding,
  type ScanReport,
  type Severity,
} from "@mofu/core/web";

interface ScanResultsProps {
  report: ScanReport;
  source: string;
  /** Latest model summary, included in the exported report. */
  summary: string | null;
  busy: boolean;
  onAskPlan: () => void;
  onClear: () => void;
}

type Kind = "all" | "vulnerable" | "outdated" | "deprecated" | "unmaintained";

const KIND_LABEL: Record<Kind, string> = {
  all: "All findings",
  vulnerable: "Vulnerable",
  outdated: "Outdated",
  deprecated: "Deprecated",
  unmaintained: "Unmaintained",
};

function matchesKind(f: Finding, kind: Kind): boolean {
  if (kind === "vulnerable") return f.vulnerabilities.length > 0;
  if (kind === "outdated") return f.behind === "major" || f.behind === "minor";
  if (kind === "deprecated") return f.deprecated;
  if (kind === "unmaintained") return f.possiblyUnmaintained;
  return true;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ScanResults({
  report,
  source,
  summary,
  busy,
  onAskPlan,
  onClear,
}: ScanResultsProps) {
  const [severity, setSeverity] = useState<Severity | "any">("any");
  const [kind, setKind] = useState<Kind>("all");
  const t = report.totals;

  const rows = useMemo(
    () =>
      report.findings.filter(
        (f) =>
          matchesKind(f, kind) &&
          (severity === "any" || f.vulnerabilities.some((v) => v.severity === severity)),
      ),
    [report, kind, severity],
  );

  return (
    <section className="scan" aria-label="Dependency scan results">
      <header className="scan-header">
        <div>
          <h2 className="scan-title">Dependency scan</h2>
          <p className="muted small">{source}</p>
        </div>
        <div className="scan-actions">
          <button
            type="button"
            className="pill-button"
            onClick={onAskPlan}
            disabled={busy || report.findings.length === 0}
          >
            Get upgrade plan
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              download("dependency-report.md", formatScanMarkdown(report, summary ?? undefined))
            }
          >
            Export Markdown
          </button>
          <button type="button" className="ghost-button" onClick={onClear}>
            New scan
          </button>
        </div>
      </header>

      <ul className="scan-totals">
        <li>
          <strong>{t.dependencies}</strong> dependencies
        </li>
        <li className={t.vulnerabilities ? "bad" : ""}>
          <strong>{t.vulnerabilities}</strong> vulnerabilities in {t.vulnerablePackages} packages
        </li>
        {SEVERITIES.filter((s) => t.bySeverity[s]).map((s) => (
          <li key={s} className={`sev sev--${s}`}>
            {t.bySeverity[s]} {s}
          </li>
        ))}
        <li>
          <strong>{t.outdatedDirect}</strong> outdated
        </li>
        <li>
          <strong>{t.deprecated}</strong> deprecated
        </li>
        <li>
          <strong>{t.possiblyUnmaintained}</strong> possibly unmaintained
        </li>
      </ul>

      {report.findings.length === 0 ? (
        <p className="status status--ok">
          No known vulnerabilities or outdated direct dependencies. Nice.
        </p>
      ) : (
        <>
          <div className="scan-filters">
            <label>
              Show{" "}
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Severity{" "}
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Severity | "any")}
              >
                <option value="any">Any</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">
              {rows.length} of {report.findings.length}
            </span>
          </div>
          <div className="scan-table-wrap">
            <table className="scan-table">
              <thead>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col">Current</th>
                  <th scope="col">Fixed in</th>
                  <th scope="col">Latest</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Vulnerabilities</th>
                  <th scope="col">Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={`${f.ecosystem}:${f.name}@${f.version}`}>
                    <th scope="row">
                      <span className="pkg">{f.name}</span>
                      <span className="eco">{f.ecosystem}</span>
                    </th>
                    <td>
                      {f.version ?? "?"}
                      {!f.resolved && (
                        <span
                          className="muted"
                          title="No lockfile: lowest version the range allows"
                        >
                          {" "}
                          *
                        </span>
                      )}
                    </td>
                    <td>
                      {f.fixVersion ??
                        (f.vulnerabilities.length ? <span className="bad">no fix</span> : "–")}
                      {f.fixIsMajor && <span className="tag tag--warn">major</span>}
                    </td>
                    <td>{f.latest ?? "?"}</td>
                    <td>
                      {f.worstSeverity ? (
                        <span className={`sev sev--${f.worstSeverity}`}>{f.worstSeverity}</span>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="ids">
                      {f.vulnerabilities.map((v) => (
                        <a
                          key={v.id}
                          href={v.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={v.summary}
                        >
                          {v.aliases.find((a) => a.startsWith("CVE-")) ?? v.id}
                        </a>
                      ))}
                    </td>
                    <td className="flags">
                      {!f.direct && <span className="tag">transitive</span>}
                      {f.behind === "major" && <span className="tag tag--warn">major behind</span>}
                      {f.deprecated && <span className="tag tag--bad">deprecated</span>}
                      {f.possiblyUnmaintained && (
                        <span className="tag" title={`Last release ${f.lastRelease?.slice(0, 10)}`}>
                          unmaintained?
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {report.notes.length > 0 && (
        <details className="scan-notes">
          <summary>{report.notes.length} note(s) about this scan</summary>
          <ul>
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">
        Data:{" "}
        <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">
          OSV
        </a>{" "}
        and{" "}
        <a href="https://deps.dev" target="_blank" rel="noopener noreferrer">
          deps.dev
        </a>
        . * = version guessed from a range (no lockfile).
      </p>
    </section>
  );
}

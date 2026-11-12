import { useState, type FormEvent } from "react";
import {
  AUDIT_LIMITS,
  auditSolidity,
  scanFiles,
  type FileAudit,
  type FileFinding,
} from "@mofu/core/web";
import { fetchGitHubFiles, GitHubError } from "../lib/github.js";

/** Text files worth scanning for secrets in a repository (binaries and lockfiles skipped). */
const TEXT_FILE =
  /(^|\/)(\.env[\w.-]*|\.dev\.vars|id_(rsa|dsa|ecdsa|ed25519)|Dockerfile|Makefile)$|\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|php|cs|sol|vy|move|txt|md|properties|xml|tf|pem|key)$/i;
const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock)$/;
const MAX_REPO_FILES = 200;

const ICON = { ok: "✓", info: "i", warn: "!", risk: "✕" } as const;
const SEVERITY_STATUS = { critical: "risk", high: "risk", medium: "warn", low: "info" } as const;
const ISSUE_STATUS = { high: "risk", medium: "warn", low: "info", info: "info" } as const;

function AuditResult({ audit }: { audit: FileAudit }) {
  const flagged = audit.checks.filter((c) => c.status !== "ok");
  const clear = audit.checks.filter((c) => c.status === "ok");
  return (
    <section className="token-report builder-report" aria-label="Contract check">
      <div className={`token-verdict token-verdict--${audit.verdict}`}>
        <strong>
          Mofu's Token Scanner would likely say:{" "}
          {audit.verdict === "clean" ? "clean" : audit.verdict === "caution" ? "caution" : "risky"}
        </strong>
        <span>
          {audit.contracts.length ? audit.contracts.join(", ") : "No contract found"} · checked in
          your browser, nothing was sent
        </span>
      </div>
      <ul className="token-checks">
        {flagged.map((c) => (
          <li key={c.id} className={`token-check token-check--${c.status}`}>
            <span className="token-check-icon" aria-hidden="true">
              {ICON[c.status]}
            </span>
            <div>
              <strong>{c.label}</strong>
              <p>
                {c.detail}
                {c.lines.length > 0 && ` (line ${c.lines.join(", ")})`}
              </p>
            </div>
          </li>
        ))}
        {audit.issues.map((i) => (
          <li
            key={`${i.id}-${i.line}`}
            className={`token-check token-check--${ISSUE_STATUS[i.severity]}`}
          >
            <span className="token-check-icon" aria-hidden="true">
              {ICON[ISSUE_STATUS[i.severity]]}
            </span>
            <div>
              <strong>
                {i.title} <span className="muted">· line {i.line}</span>
              </strong>
              <p>{i.detail}</p>
              {i.snippet && <code className="builder-snippet">{i.snippet}</code>}
            </div>
          </li>
        ))}
      </ul>
      {clear.length > 0 && (
        <p className="muted builder-note">
          Clear: {clear.map((c) => c.label.replace(/\?$/, "")).join(" · ")}.
        </p>
      )}
      <p className="muted builder-note">{AUDIT_LIMITS.join(" ")}</p>
    </section>
  );
}

function SecretsResult({
  findings,
  scanned,
  source,
}: {
  findings: FileFinding[];
  scanned: number;
  source: string;
}) {
  const real = findings.filter((f) => f.severity !== "low");
  return (
    <section className="token-report builder-report" aria-label="Secret scan">
      <div className={`token-verdict token-verdict--${real.length ? "risky" : "clean"}`}>
        <strong>
          {real.length
            ? `${real.length} possible secret${real.length === 1 ? "" : "s"} found`
            : "No secrets found"}
        </strong>
        <span>
          {scanned} file{scanned === 1 ? "" : "s"} from {source} · scanned in your browser, values
          shown redacted
        </span>
      </div>
      {findings.length > 0 && (
        <ul className="token-checks">
          {findings.map((f, n) => (
            <li
              key={`${f.file}-${f.line}-${n}`}
              className={`token-check token-check--${SEVERITY_STATUS[f.severity]}`}
            >
              <span className="token-check-icon" aria-hidden="true">
                {ICON[SEVERITY_STATUS[f.severity]]}
              </span>
              <div>
                <strong>
                  {f.title} <code>{f.preview}</code>
                </strong>
                <p>
                  {f.file}:{f.line} · {f.severity}
                  {f.note && ` · ${f.note}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted builder-note">
        {real.length
          ? "A leaked key stays usable until you revoke it at the provider. A leaked wallet key or seed phrase: move the funds to a new wallet. "
          : ""}
        This checks the files as they are now. Deleted keys can still be in git history: run{" "}
        <code>npx mofu-cli secrets</code> in the repository to read every commit.
      </p>
    </section>
  );
}

export function BuilderPanel({ tool }: { tool: "audit" | "secrets" }) {
  const [code, setCode] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [audit, setAudit] = useState<FileAudit | null>(null);
  const [secrets, setSecrets] = useState<{
    findings: FileFinding[];
    scanned: number;
    source: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setAudit(auditSolidity("Contract.sol", code));
  };

  const scanPasted = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setError(null);
    setSecrets({
      findings: scanFiles([{ path: "pasted text", content: code }]),
      scanned: 1,
      source: "the pasted text",
    });
  };

  const scanRepo = async (e: FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const got = await fetchGitHubFiles(repoUrl.trim(), TEXT_FILE, MAX_REPO_FILES);
      const files = got.files
        .filter((f) => !SKIP_FILE.test(f.path) && f.text.length < 500_000)
        .slice(0, MAX_REPO_FILES)
        .map((f) => ({ path: f.path, content: f.text }));
      setSecrets({
        findings: scanFiles(files),
        scanned: files.length,
        source: `${got.fullName} (${got.branch})`,
      });
    } catch (err) {
      setError(
        err instanceof GitHubError || err instanceof Error
          ? err.message
          : "Couldn't read that repository.",
      );
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("That file is over 1 MB.");
      return;
    }
    setError(null);
    setCode(await file.text());
  };

  if (tool === "audit") {
    return (
      <div className="builder-panel">
        <form className="builder-form" onSubmit={runAudit}>
          <label htmlFor="builder-sol" className="visually-hidden">
            Solidity source
          </label>
          <textarea
            id="builder-sol"
            rows={8}
            spellCheck={false}
            placeholder="Paste a Solidity contract to see what Mofu's Token Scanner will say once it's deployed, plus common bugs. It's checked in your browser."
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setAudit(null);
            }}
          />
          <div className="builder-actions">
            <label className="ghost-button builder-file">
              Open a .sol file
              <input
                type="file"
                accept=".sol,text/plain"
                onChange={(e) => void loadFile(e.target.files?.[0])}
                hidden
              />
            </label>
            <button type="submit" className="pill-button" disabled={!code.trim()}>
              Check contract
            </button>
          </div>
          {error && (
            <p className="status status--bad" role="alert">
              {error}
            </p>
          )}
        </form>
        {audit && <AuditResult audit={audit} />}
      </div>
    );
  }

  return (
    <div className="builder-panel">
      <form className="repo-form" onSubmit={(e) => void scanRepo(e)}>
        <label htmlFor="builder-repo" className="visually-hidden">
          Public GitHub repository URL
        </label>
        <input
          id="builder-repo"
          type="text"
          inputMode="url"
          spellCheck={false}
          placeholder="Public GitHub repo to check for leaked secrets, e.g. github.com/you/your-dapp"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="pill-button" disabled={busy || !repoUrl.trim()}>
          {busy ? "Reading…" : "Scan repo"}
        </button>
      </form>
      <form className="builder-form" onSubmit={scanPasted}>
        <label htmlFor="builder-text" className="visually-hidden">
          Code or config to scan
        </label>
        <textarea
          id="builder-text"
          rows={5}
          spellCheck={false}
          placeholder="Or paste code, a config file or a log. Mofu looks for wallet keys, seed phrases and API tokens, right here in your browser."
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="builder-actions">
          <button type="submit" className="pill-button" disabled={!code.trim()}>
            Scan text
          </button>
        </div>
        {error && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}
      </form>
      {secrets && <SecretsResult {...secrets} />}
    </div>
  );
}

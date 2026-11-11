import { useState, type FormEvent } from "react";
import type { TokenCheck, TokenScanReport } from "../../shared/api.js";

const MOFU_CA = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface TokenPanelProps {
  scanning: boolean;
  error: string | null;
  onScan: (address: string) => void;
}

/** Input for the Token Scanner (Dev Tools → Scan a token). */
export function TokenPanel({ scanning, error, onScan }: TokenPanelProps) {
  const [value, setValue] = useState("");
  const address = value.trim();
  const valid = ADDRESS.test(address);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !scanning) onScan(address);
  };

  return (
    <form className="repo-form token-form" onSubmit={submit}>
      <label htmlFor="token-ca" className="visually-hidden">
        Token contract address on Robinhood Chain
      </label>
      <input
        id="token-ca"
        type="text"
        placeholder="Paste a token contract address (0x…) on Robinhood Chain"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={scanning}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="pill-button" disabled={scanning || !valid}>
        {scanning ? "Scanning…" : "Scan"}
      </button>
      {address && !valid && (
        <p className="status status--bad repo-error">
          A contract address is 0x followed by 40 letters and digits.
        </p>
      )}
      {error && (
        <p className="status status--bad repo-error" role="alert">
          {error}
        </p>
      )}
      {!address && !error && (
        <p className="muted small repo-error">
          Not sure where to start?{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => onScan(MOFU_CA)}
            disabled={scanning}
          >
            Scan $MOFU
          </button>
        </p>
      )}
    </form>
  );
}

const VERDICT: Record<TokenScanReport["verdict"], { title: string; body: string }> = {
  clean: {
    title: "No red flags in the code",
    body: "None of the common owner powers were found. That's about the code, not the price or the team.",
  },
  caution: {
    title: "A few things to check",
    body: "Some functions or settings deserve a closer look. Read the lines marked below.",
  },
  risky: {
    title: "Someone has strong control",
    body: "The code lets someone change how this token works. Read the lines marked below before you trust it.",
  },
};

const ICON: Record<TokenCheck["status"], string> = { ok: "✓", warn: "!", risk: "✕", info: "i" };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface TokenReportProps {
  report: TokenScanReport;
  remaining: number | null;
  busy: boolean;
  onExplain: () => void;
  onClear: () => void;
}

export function TokenReport({ report, remaining, busy, onExplain, onClear }: TokenReportProps) {
  const [copied, setCopied] = useState(false);
  const t = report.token;
  const v = report.isContract
    ? VERDICT[report.verdict]
    : {
        title: "Not a token contract",
        body: `There's no contract at this address on ${report.chainName}. It's a regular wallet, or the address is wrong.`,
      };
  const title = t.name ? `${t.name}${t.symbol ? ` (${t.symbol})` : ""}` : short(report.address);

  const copyLink = async () => {
    const url = `${location.origin}/app/?scan=${report.address}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link:", url);
    }
  };

  return (
    <section className="scan token-report" aria-label="Token scan report">
      <header className="scan-header">
        <div>
          <p className="token-kicker">TOKEN SCAN · {report.chainName.toUpperCase()}</p>
          <h2 className="scan-title">{title}</h2>
          <p className="muted small">
            <code className="token-addr">{report.address}</code>
          </p>
        </div>
        <div className="scan-actions">
          <button type="button" className="pill-button" onClick={onExplain} disabled={busy}>
            Explain this
          </button>
          <button type="button" className="ghost-button" onClick={() => void copyLink()}>
            {copied ? "Link copied" : "Copy link"}
          </button>
          <button type="button" className="ghost-button" onClick={onClear}>
            Scan another
          </button>
        </div>
      </header>

      <div className={`token-verdict token-verdict--${report.verdict}`}>
        <strong>{v.title}</strong>
        <span>{v.body}</span>
      </div>

      {report.isContract && (
        <ul className="scan-totals">
          {t.totalSupply && (
            <li>
              Supply <strong>{BigInt(t.totalSupply).toLocaleString("en-US")}</strong>
            </li>
          )}
          <li>
            Owner{" "}
            <strong>
              {report.owner.status === "active"
                ? short(report.owner.address ?? "")
                : report.owner.status === "renounced"
                  ? "renounced"
                  : "none"}
            </strong>
          </li>
          {report.burnedPercent !== null && report.burnedPercent > 0 && (
            <li>
              Burned <strong>{Number(report.burnedPercent.toFixed(2))}%</strong>
            </li>
          )}
          <li>
            Upgradeable <strong>{report.proxy.kind === "none" ? "no" : "yes"}</strong>
          </li>
        </ul>
      )}

      <ul className="token-checks">
        {report.checks.map((c) => (
          <li key={c.id} className={`token-check token-check--${c.status}`}>
            <span className="token-check-icon" aria-hidden="true">
              {ICON[c.status]}
            </span>
            <div>
              <strong>{c.label}</strong>
              <p>{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      <details className="scan-notes">
        <summary>What this scan can't see</summary>
        <ul>
          {report.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
      <p className="muted small">
        A technical check of the contract, not financial advice. It doesn't say whether to buy or
        sell.
        {remaining !== null && ` ${remaining} scans left today.`}
      </p>
    </section>
  );
}

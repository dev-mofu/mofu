import { useState, type FormEvent } from "react";
import type { TokenCheck, TokenScanReport, TxReport } from "../../shared/api.js";

const MOFU_CA = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EXPLORER = "https://robinhoodchain.blockscout.com";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Addr({ a, kind = "address" }: { a: string; kind?: "address" | "tx" }) {
  return (
    <a
      className="token-addr-link"
      href={`${EXPLORER}/${kind}/${a}`}
      target="_blank"
      rel="noopener noreferrer"
      title={a}
    >
      <code>{short(a)}</code>
    </a>
  );
}

async function copy(url: string, done: () => void) {
  try {
    await navigator.clipboard.writeText(url);
    done();
  } catch {
    window.prompt("Copy this link:", url);
  }
}

interface TokenPanelProps {
  scanning: boolean;
  error: string | null;
  onScan: (address: string) => void;
  onTx: (hash: string) => void;
}

/** Input for Dev Tools → Scan a token: a contract address scans it, a tx hash explains it. */
export function TokenPanel({ scanning, error, onScan, onTx }: TokenPanelProps) {
  const [value, setValue] = useState("");
  const input = value.trim();
  const isAddress = ADDRESS.test(input);
  const isTx = TX_HASH.test(input);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (scanning) return;
    if (isAddress) onScan(input);
    else if (isTx) onTx(input);
  };

  return (
    <form className="repo-form token-form" onSubmit={submit}>
      <label htmlFor="token-ca" className="visually-hidden">
        Token contract address or transaction hash on Robinhood Chain
      </label>
      <input
        id="token-ca"
        type="text"
        placeholder="Paste a token address or a transaction hash (0x…) on Robinhood Chain"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={scanning}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="pill-button" disabled={scanning || !(isAddress || isTx)}>
        {scanning ? "Reading…" : isTx ? "Explain" : "Scan"}
      </button>
      {input && !isAddress && !isTx && (
        <p className="status status--bad repo-error">
          A token address is 0x plus 40 characters; a transaction hash is 0x plus 64.
        </p>
      )}
      {error && (
        <p className="status status--bad repo-error" role="alert">
          {error}
        </p>
      )}
      {!input && !error && (
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

const KIND_LABEL = { wallet: "wallet", contract: "pool or curve", burn: "burned" } as const;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "unknown";

interface TokenReportProps {
  report: TokenScanReport;
  remaining: number | null;
  busy: boolean;
  onExplain: () => void;
  onClear: () => void;
  /** Opens the holder-perks settings (shown on the locked part of the report). */
  onUnlock: () => void;
}

export function TokenReport({
  report,
  remaining,
  busy,
  onExplain,
  onClear,
  onUnlock,
}: TokenReportProps) {
  const [copied, setCopied] = useState(false);
  const t = report.token;
  const v = report.isContract
    ? VERDICT[report.verdict]
    : {
        title: "Not a token contract",
        body: `There's no contract at this address on ${report.chainName}. It's a regular wallet, or the address is wrong.`,
      };
  const title = t.name ? `${t.name}${t.symbol ? ` (${t.symbol})` : ""}` : short(report.address);
  const d = report.distribution;
  const o = report.origin;
  const max = Math.max(1, ...d.holders.map((h) => h.percent));

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
          {report.isContract && (
            <a
              className="ghost-button"
              href={`https://x.com/intent/post?text=${encodeURIComponent(`${title} on Robinhood Chain, checked with Mofu's Token Scanner.`)}&url=${encodeURIComponent(`https://mofu.works/token/${report.address}`)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Share on X
            </a>
          )}
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              void copy(`${location.origin}/token/${report.address}`, () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              })
            }
          >
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
          {d.top10Percent !== null && (
            <li>
              Top 10 hold <strong>{Number(d.top10Percent.toFixed(2))}%</strong>
            </li>
          )}
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

      {d.status === "full" && (
        <div className="token-section">
          <h3>Who holds it</h3>
          <ol className="holder-list">
            {d.holders.map((h, i) => (
              <li key={h.address} className={`holder holder--${h.kind}`}>
                <span className="holder-rank">#{i + 1}</span>
                <Addr a={h.address} />
                <span className="holder-kind">{KIND_LABEL[h.kind]}</span>
                <span className="holder-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(2, (h.percent / max) * 100)}%` }} />
                </span>
                <strong className="holder-pct">{Number(h.percent.toFixed(2))}%</strong>
              </li>
            ))}
          </ol>
        </div>
      )}

      {o && (
        <div className="token-section">
          <h3>Who created it</h3>
          <ul className="origin-facts">
            <li>
              <span>Creator</span> <Addr a={o.creator} />
              {o.launcher && (
                <>
                  {" "}
                  via launcher <Addr a={o.launcher} />
                </>
              )}
            </li>
            <li>
              <span>Created</span> {fmtDate(o.createdAt)} · <Addr a={o.creationTx} kind="tx" />
            </li>
            <li>
              <span>Creator wallet</span>{" "}
              {o.creatorAgeDays === null
                ? "age unknown"
                : o.creatorAgeDays === 0
                  ? "first active the same day"
                  : `first active ${o.creatorAgeDays} days earlier`}
              {o.creatorTxCount !== null &&
                ` · ${o.creatorTxCount.toLocaleString("en-US")} transactions`}
            </li>
            <li>
              <span>Still holds</span>{" "}
              {o.creatorHoldsPercent === null
                ? "unknown"
                : `${Number(o.creatorHoldsPercent.toFixed(2))}% of the supply`}
            </li>
            <li>
              <span>Other launches</span>{" "}
              {o.otherLaunchCount === 0
                ? "none through the same launcher in its recent history"
                : `${o.otherLaunchCount} other token${o.otherLaunchCount === 1 ? "" : "s"} through the same launcher recently`}
            </li>
          </ul>
        </div>
      )}

      {d.status === "summary" && (
        <div className="token-locked">
          <p>
            <strong>Full report for $MOFU holders.</strong> See the top 10 wallets and who created
            this token: connect a wallet that holds 1,000,000+ $MOFU.
          </p>
          <button type="button" className="ghost-button" onClick={onUnlock}>
            Connect wallet
          </button>
        </div>
      )}

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

interface TxReportProps {
  report: TxReport;
  remaining: number | null;
  busy: boolean;
  onExplain: () => void;
  onClear: () => void;
}

/** Decoded transaction: flags first, then transfers and approvals. */
export function TxReportView({ report, remaining, busy, onExplain, onClear }: TxReportProps) {
  const [copied, setCopied] = useState(false);
  const r = report;
  const risky = r.flags.some((f) => f.level === "risk");
  return (
    <section className="scan token-report" aria-label="Transaction report">
      <header className="scan-header">
        <div>
          <p className="token-kicker">TRANSACTION · {r.chainName.toUpperCase()}</p>
          <h2 className="scan-title">
            {r.approvals.length
              ? "Approval transaction"
              : r.transfers.some((t) => t.mint)
                ? "Token mint"
                : r.transfers.length
                  ? "Token transfer"
                  : "Transaction"}
          </h2>
          <p className="muted small">
            <Addr a={r.hash} kind="tx" /> · {fmtDate(r.time)}
          </p>
        </div>
        <div className="scan-actions">
          <button type="button" className="pill-button" onClick={onExplain} disabled={busy}>
            Explain this
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              void copy(`${location.origin}/app/?tx=${r.hash}`, () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              })
            }
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
          <button type="button" className="ghost-button" onClick={onClear}>
            Explain another
          </button>
        </div>
      </header>

      <div
        className={`token-verdict token-verdict--${r.status === "failed" ? "caution" : risky ? "risky" : r.flags.length ? "caution" : "clean"}`}
      >
        <strong>
          {r.status === "failed"
            ? "This transaction failed"
            : risky
              ? "Look at the approvals below"
              : r.flags.length
                ? "Worth a look"
                : "Nothing unusual found"}
        </strong>
        <span>
          From <Addr a={r.from} /> to {r.to ? <Addr a={r.to} /> : "a new contract"}
          {r.toIsContract ? " (a contract)" : r.toIsContract === false ? " (a wallet)" : ""}. Sent{" "}
          {r.valueEth} ETH, fee {r.feeEth} ETH.
        </span>
      </div>

      {r.flags.length > 0 && (
        <ul className="token-checks">
          {r.flags.map((f) => (
            <li key={f.text} className={`token-check token-check--${f.level}`}>
              <span className="token-check-icon" aria-hidden="true">
                {f.level === "risk" ? "✕" : "!"}
              </span>
              <div>
                <p className="flag-text">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="token-section">
        <h3>Token transfers</h3>
        {r.transfers.length === 0 ? (
          <p className="muted small">No token moved in this transaction.</p>
        ) : (
          <ul className="tx-list">
            {r.transfers.map((t, i) => (
              <li key={i}>
                <strong>
                  {t.amount} {t.symbol ?? short(t.token)}
                </strong>
                <span className="tx-route">
                  {t.mint ? <em>new tokens minted</em> : <Addr a={t.from} />} →{" "}
                  {t.burn ? <em>burned</em> : <Addr a={t.to} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {r.approvals.length > 0 && (
        <div className="token-section">
          <h3>Approvals</h3>
          <ul className="tx-list">
            {r.approvals.map((a, i) => (
              <li key={i} className={a.unlimited ? "tx-approval--unlimited" : ""}>
                <strong>
                  {a.amount} {a.symbol ?? short(a.token)}
                </strong>
                <span className="tx-route">
                  <Addr a={a.owner} /> lets <Addr a={a.spender} />
                  {a.spenderIsContract === false ? " (a plain wallet)" : ""} spend it
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            To remove an approval, use your wallet's approvals page or a revoke tool, and set the
            allowance back to 0.
          </p>
        </div>
      )}

      {r.otherEvents.length > 0 && (
        <p className="muted small">Other events: {r.otherEvents.join(", ")}</p>
      )}
      <p className="muted small">
        Decoded from indexed Robinhood Chain data. Not financial advice.
        {remaining !== null && ` ${remaining} scans left today.`}
      </p>
    </section>
  );
}

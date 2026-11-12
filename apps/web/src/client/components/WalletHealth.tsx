import { useEffect, useState } from "react";
import type { WalletApproval, WalletReport } from "../../shared/api.js";
import { quickCheck, type QuickCheck } from "../lib/api.js";
import { revokeApproval, WalletError } from "../lib/wallet.js";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ICON = { ok: "✓", warn: "!", risk: "✕" } as const;
const KIND = {
  wallet: "plain wallet",
  burn: "burn address",
  token: "token contract",
  curve: "launch curve",
  pool: "liquidity pool",
  contract: "contract",
} as const;
const VERDICT = {
  clean: ["No red flags", "ok"],
  caution: ["Things to check", "warn"],
  risky: ["Strong owner control", "risk"],
} as const;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "unknown date";

function Link({ a, kind = "address" }: { a: string; kind?: "address" | "tx" }) {
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

type RevokeState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "sent"; hash: string }
  | {
      state: "error";
      message: string;
    };

function ApprovalRow({ a, owner }: { a: WalletApproval; owner: string }) {
  const [revoke, setRevoke] = useState<RevokeState>({ state: "idle" });
  const token = a.tokenSymbol ? `$${a.tokenSymbol}` : (a.tokenName ?? short(a.token));
  const spender = a.spender.label ?? KIND[a.spender.kind];

  const send = async () => {
    setRevoke({ state: "sending" });
    try {
      const hash = await revokeApproval(owner, a.token, a.spender.address);
      setRevoke({ state: "sent", hash });
    } catch (err) {
      setRevoke({
        state: "error",
        message: err instanceof WalletError ? err.message : "The revoke didn't go through.",
      });
    }
  };

  return (
    <li className={`token-check token-check--${a.risk} approval`}>
      <span className="token-check-icon" aria-hidden="true">
        {ICON[a.risk]}
      </span>
      <div>
        <strong>
          {token} → {spender}
        </strong>
        <p className="approval-meta">
          Spender <Link a={a.spender.address} /> ·{" "}
          {a.unlimited ? "unlimited" : `up to ${a.allowance}`}
          {" · "}approved {fmtDate(a.approvedAt)}
          {a.txHash && (
            <>
              {" "}
              (<Link a={a.txHash} kind="tx" />)
            </>
          )}
          {a.balance !== null && ` · you hold ${a.balance}`}
        </p>
        {a.reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <div className="approval-actions">
          {revoke.state === "sent" ? (
            <p className="status status--ok">
              Revoke sent (<Link a={revoke.hash} kind="tx" />
              ). Check again in a minute to see it gone.
            </p>
          ) : (
            <button
              type="button"
              className={a.risk === "ok" ? "ghost-button" : "pill-button"}
              onClick={() => void send()}
              disabled={revoke.state === "sending"}
            >
              {revoke.state === "sending" ? "Confirm in your wallet…" : "Revoke"}
            </button>
          )}
          {revoke.state === "error" && (
            <p className="status status--bad" role="alert">
              {revoke.message}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

interface Props {
  report: WalletReport;
  remaining: number | null;
  busy: boolean;
  onExplain: () => void;
  onRecheck: () => void;
  onClear: () => void;
  onScanToken: (address: string) => void;
}

export function WalletHealthView({
  report,
  remaining,
  busy,
  onExplain,
  onRecheck,
  onClear,
  onScanToken,
}: Props) {
  const risky = report.approvals.filter((a) => a.risk === "risk").length;
  const toCheck = report.approvals.filter((a) => a.risk === "warn").length;
  const verdict =
    risky > 0
      ? {
          cls: "risky",
          title: `${risky} risky approval${risky === 1 ? "" : "s"}`,
          body: "Something can take tokens from this wallet in a way apps don't need. Revoke it unless you're sure what it is.",
        }
      : toCheck > 0
        ? {
            cls: "caution",
            title: `${toCheck} approval${toCheck === 1 ? "" : "s"} to check`,
            body: "Mostly unlimited approvals to busy contracts. Normal after trading, but revoking the ones you don't use is good hygiene.",
          }
        : {
            cls: "clean",
            title: "No risky approvals found",
            body:
              report.approvals.length === 0
                ? "This wallet has no active token approvals."
                : "The active approvals are limited or go to established contracts.",
          };

  // Light scans of the tokens it holds, a few at a time.
  const [checks, setChecks] = useState<Record<string, QuickCheck | "error">>({});
  useEffect(() => {
    let cancelled = false;
    const list = report.holdings.slice(0, 12).map((h) => h.token);
    void (async () => {
      for (let i = 0; i < list.length && !cancelled; i += 3) {
        await Promise.all(
          list.slice(i, i + 3).map(async (t) => {
            const r = await quickCheck(t).catch(() => "error" as const);
            if (!cancelled) setChecks((prev) => ({ ...prev, [t]: r }));
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [report]);

  return (
    <section className="scan token-report" aria-label="Wallet Health report">
      <header className="scan-header">
        <div>
          <p className="token-kicker">WALLET HEALTH · ROBINHOOD CHAIN</p>
          <h2 className="scan-title">{short(report.address)}</h2>
          <p className="muted small">
            <code className="token-addr">{report.address}</code>
          </p>
        </div>
        <div className="scan-actions">
          <button type="button" className="pill-button" onClick={onExplain} disabled={busy}>
            Explain this
          </button>
          <button type="button" className="ghost-button" onClick={onRecheck} disabled={busy}>
            Check again
          </button>
          <button type="button" className="ghost-button" onClick={onClear}>
            Check another
          </button>
        </div>
      </header>

      <div className={`token-verdict token-verdict--${verdict.cls}`}>
        <strong>{verdict.title}</strong>
        <span>{verdict.body}</span>
      </div>

      <ul className="scan-totals">
        {report.eth !== null && (
          <li>
            ETH <strong>{report.eth}</strong>
          </li>
        )}
        <li>
          Tokens held <strong>{report.holdingsTotal}</strong>
        </li>
        <li>
          Active approvals <strong>{report.approvals.length}</strong>
        </li>
      </ul>

      {report.isContract && (
        <p className="status">
          This address is a contract (a smart wallet, vault or app), so approvals here may be part
          of how it works.
        </p>
      )}

      <div className="token-section">
        <h3>Token approvals</h3>
        {report.status.approvals === "unavailable" ? (
          <p className="muted">Approvals couldn't be read right now. Try again in a minute.</p>
        ) : report.approvals.length === 0 ? (
          <p className="muted">
            No active token approvals. Nothing can spend this wallet's tokens.
          </p>
        ) : (
          <>
            <p className="muted small">
              Revoking sends one transaction from your wallet, approve(spender, 0). It costs a
              little gas, removes the permission and can't move your tokens. Connect the wallet
              you're checking to use it.
            </p>
            <ul className="token-checks">
              {report.approvals.map((a) => (
                <ApprovalRow key={`${a.token}:${a.spender.address}`} a={a} owner={report.address} />
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="token-section">
        <h3>What it holds</h3>
        {report.status.holdings === "unavailable" ? (
          <p className="muted">Holdings couldn't be read right now.</p>
        ) : report.holdings.length === 0 ? (
          <p className="muted">No tokens besides ETH.</p>
        ) : (
          <ul className="wallet-holdings">
            {report.holdings.map((h) => {
              const q = checks[h.token];
              const v = q && q !== "error" && q.isContract ? VERDICT[q.verdict] : null;
              return (
                <li key={h.token}>
                  <span className="wallet-token">
                    <strong>{h.symbol ? `$${h.symbol}` : short(h.token)}</strong>
                    <span className="muted small">{h.name}</span>
                  </span>
                  <span className="wallet-balance">{h.balance}</span>
                  <span className={`wallet-verdict wallet-verdict--${v ? v[1] : "none"}`}>
                    {v ? v[0] : q === "error" ? "—" : report.holdings.indexOf(h) < 12 ? "…" : ""}
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onScanToken(h.token)}
                  >
                    Scan
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <details className="scan-notes">
        <summary>What this check can't see</summary>
        <ul>
          {report.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
      <p className="muted small">
        Mofu never asks for your seed phrase and never asks you to approve anything. The only
        transaction it offers is a revoke.
        {remaining !== null && ` ${remaining} scans left today.`}
      </p>
    </section>
  );
}

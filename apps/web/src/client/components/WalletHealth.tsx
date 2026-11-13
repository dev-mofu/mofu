import { useEffect, useState } from "react";
import type { WalletApproval, WalletNftApproval, WalletReport } from "../../shared/api.js";
import { quickCheck, type QuickCheck } from "../lib/api.js";
import {
  isRevoked,
  sendRevokes,
  waitForRevoke,
  WalletError,
  type RevokeItem,
} from "../lib/wallet.js";

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

type RowState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "pending"; hash?: string }
  | { state: "verified"; hash?: string }
  | { state: "still"; hash?: string }
  | { state: "error"; message: string };

interface Entry {
  key: string;
  item: RevokeItem;
  risk: WalletApproval["risk"];
}

function RevokeActions({
  risk,
  row,
  onRevoke,
}: {
  risk: WalletApproval["risk"];
  row: RowState;
  onRevoke: () => void;
}) {
  return (
    <div className="approval-actions">
      {row.state === "verified" ? (
        <p className="status status--ok">
          Revoked, checked on the chain
          {row.hash && (
            <>
              {" "}
              (<Link a={row.hash} kind="tx" />)
            </>
          )}
          .
        </p>
      ) : row.state === "pending" ? (
        <p className="status">
          Sent
          {row.hash && (
            <>
              {" "}
              (<Link a={row.hash} kind="tx" />)
            </>
          )}
          . Waiting for it to land, then reading it back from the chain…
        </p>
      ) : (
        <button
          type="button"
          className={risk === "ok" ? "ghost-button" : "pill-button"}
          onClick={onRevoke}
          disabled={row.state === "sending"}
        >
          {row.state === "sending"
            ? "Confirm in your wallet…"
            : row.state === "still"
              ? "Try again"
              : "Revoke"}
        </button>
      )}
      {row.state === "still" && (
        <p className="status status--bad" role="alert">
          The chain still shows this approval. The transaction may have failed.
        </p>
      )}
      {row.state === "error" && (
        <p className="status status--bad" role="alert">
          {row.message}
        </p>
      )}
    </div>
  );
}

function ApprovalRow({
  a,
  row,
  onRevoke,
}: {
  a: WalletApproval;
  row: RowState;
  onRevoke: () => void;
}) {
  const token = a.tokenSymbol ? `$${a.tokenSymbol}` : (a.tokenName ?? short(a.token));
  const spender = a.spender.label ?? KIND[a.spender.kind];
  return (
    <li className={`token-check token-check--${row.state === "verified" ? "ok" : a.risk} approval`}>
      <span className="token-check-icon" aria-hidden="true">
        {row.state === "verified" ? ICON.ok : ICON[a.risk]}
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
        <RevokeActions risk={a.risk} row={row} onRevoke={onRevoke} />
      </div>
    </li>
  );
}

function NftApprovalRow({
  a,
  row,
  onRevoke,
}: {
  a: WalletNftApproval;
  row: RowState;
  onRevoke: () => void;
}) {
  const collection = a.name ?? (a.symbol ? `$${a.symbol}` : short(a.collection));
  const operator = a.operator.label ?? KIND[a.operator.kind];
  return (
    <li className={`token-check token-check--${row.state === "verified" ? "ok" : a.risk} approval`}>
      <span className="token-check-icon" aria-hidden="true">
        {row.state === "verified" ? ICON.ok : ICON[a.risk]}
      </span>
      <div>
        <strong>
          {collection} (all items) → {operator}
        </strong>
        <p className="approval-meta">
          Collection <Link a={a.collection} /> · operator <Link a={a.operator.address} />
          {a.approvedAt && ` · approved ${fmtDate(a.approvedAt)}`}
          {a.txHash && (
            <>
              {" "}
              (<Link a={a.txHash} kind="tx" />)
            </>
          )}
        </p>
        {a.reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <RevokeActions risk={a.risk} row={row} onRevoke={onRevoke} />
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
  const nfts = report.nftApprovals ?? [];
  const entries: Entry[] = [
    ...report.approvals.map((a) => ({
      key: `token:${a.token}:${a.spender.address}`,
      item: { kind: "token" as const, contract: a.token, spender: a.spender.address },
      risk: a.risk,
    })),
    ...nfts.map((a) => ({
      key: `nft:${a.collection}:${a.operator.address}`,
      item: { kind: "nft" as const, contract: a.collection, spender: a.operator.address },
      risk: a.risk,
    })),
  ];
  const [rows, setRows] = useState<Record<string, RowState>>({});
  useEffect(() => setRows({}), [report]);
  const rowOf = (key: string): RowState => rows[key] ?? { state: "idle" };
  const setRow = (key: string, s: RowState) => setRows((p) => ({ ...p, [key]: s }));

  /** Sends the revokes, then waits for each to land and reads it back from the chain. */
  const revoke = async (list: Entry[]) => {
    if (!list.length) return;
    for (const e of list) setRow(e.key, { state: "sending" });
    const waits = new Map<string, Promise<boolean>>();
    const checks: Promise<void>[] = [];
    try {
      await sendRevokes(
        report.address,
        list.map((e) => e.item),
        (i, ref) => {
          const e = list[i]!;
          setRow(e.key, { state: "pending", hash: ref.hash });
          const id = ref.hash ?? ref.batch ?? e.key;
          if (!waits.has(id)) waits.set(id, waitForRevoke(ref));
          checks.push(
            waits.get(id)!.then(async () => {
              const gone = await isRevoked(report.address, e.item);
              setRow(
                e.key,
                gone === false
                  ? { state: "still", hash: ref.hash }
                  : { state: "verified", hash: ref.hash },
              );
            }),
          );
        },
      );
    } catch (err) {
      const message = err instanceof WalletError ? err.message : "The revoke didn't go through.";
      setRows((p) => {
        const next = { ...p };
        for (const e of list)
          if (next[e.key]?.state === "sending") next[e.key] = { state: "error", message };
        return next;
      });
    }
    await Promise.all(checks);
  };
  const open = entries.filter((e) => e.risk !== "ok" && rowOf(e.key).state !== "verified");
  const openRisky = open.filter((e) => e.risk === "risk");
  const busyRevoking = entries.some((e) => ["sending", "pending"].includes(rowOf(e.key).state));

  const risky = openRisky.length;
  const toCheck = open.length - openRisky.length;
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
        : entries.some((e) => rowOf(e.key).state === "verified")
          ? {
              cls: "clean",
              title: "Cleaned up",
              body: "Everything flagged was revoked, and each revoke was read back from the chain.",
            }
          : {
              cls: "clean",
              title: "No risky approvals found",
              body:
                entries.length === 0
                  ? "This wallet has no active token or NFT approvals."
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

      {open.length > 0 && !report.isContract && (
        <div className="cleanup-bar">
          <div>
            <strong>Clean up</strong>
            <span className="muted small">
              {" "}
              One confirmation if your wallet can batch transactions, otherwise one per approval.
              Each is read back from the chain once it lands.
            </span>
          </div>
          <div className="cleanup-actions">
            {openRisky.length > 0 && (
              <button
                type="button"
                className="pill-button"
                disabled={busyRevoking}
                onClick={() => void revoke(openRisky)}
              >
                Revoke {openRisky.length} risky
              </button>
            )}
            {open.length > openRisky.length && (
              <button
                type="button"
                className={openRisky.length ? "ghost-button" : "pill-button"}
                disabled={busyRevoking}
                onClick={() => void revoke(open)}
              >
                {open.length === 1 ? "Revoke 1 flagged" : `Revoke all ${open.length} flagged`}
              </button>
            )}
          </div>
        </div>
      )}

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
          Active approvals <strong>{report.approvals.length + nfts.length}</strong>
        </li>
      </ul>

      {report.isContract && (
        <p className="status">
          This address is a contract (a smart wallet, vault or app), so approvals here may be part
          of how it works.
        </p>
      )}

      {(report.poisoning ?? []).length > 0 && (
        <div className="token-section">
          <h3>Lookalike addresses in your history</h3>
          <p className="muted small">
            Someone sent these transfers to plant an address that starts and ends like one you use.
            If you copy an address from your history, you could send to the scammer. Copy addresses
            from their source, and check every character.
          </p>
          <ul className="token-checks">
            {report.poisoning.map((p) => (
              <li key={p.address} className={`token-check token-check--${p.risk}`}>
                <span className="token-check-icon" aria-hidden="true">
                  {p.risk === "risk" ? "✕" : "!"}
                </span>
                <div>
                  <strong>
                    {p.resembles
                      ? p.resemblesSelf
                        ? "A lookalike of your own address"
                        : "A lookalike of an address you've sent to"
                      : "A 0-token transfer you didn't make"}
                  </strong>
                  {/* Full addresses: shortened, a lookalike and the real one look the same. */}
                  <p>
                    Don't send to <code className="token-addr">{p.address}</code>
                  </p>
                  {p.resembles && (
                    <p>
                      {p.resemblesSelf ? "Your address" : "The real one"}:{" "}
                      <code className="token-addr">{p.resembles}</code>
                    </p>
                  )}
                  <p>
                    {p.kind === "zero-transfer"
                      ? "Planted with a 0-token transfer"
                      : "Planted with a tiny transfer"}
                    {p.tokenSymbol ? ` of ${p.tokenSymbol}` : ""}
                    {p.at ? ` on ${new Date(p.at).toLocaleDateString()}` : ""}.
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
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
              Revoking sends approve(spender, 0) from your wallet. It costs a little gas, removes
              the permission and can't move your tokens. Connect the wallet you're checking to use
              it.
            </p>
            <ul className="token-checks">
              {report.approvals.map((a) => {
                const key = `token:${a.token}:${a.spender.address}`;
                const e = entries.find((x) => x.key === key)!;
                return (
                  <ApprovalRow key={key} a={a} row={rowOf(key)} onRevoke={() => void revoke([e])} />
                );
              })}
            </ul>
          </>
        )}
      </div>

      {nfts.length > 0 && (
        <div className="token-section">
          <h3>NFT collection approvals</h3>
          <p className="muted small">
            Each one lets the operator move every NFT you hold in that collection. Revoking sends
            setApprovalForAll(operator, false) and can't move your NFTs.
          </p>
          <ul className="token-checks">
            {nfts.map((a) => {
              const key = `nft:${a.collection}:${a.operator.address}`;
              const e = entries.find((x) => x.key === key)!;
              return (
                <NftApprovalRow
                  key={key}
                  a={a}
                  row={rowOf(key)}
                  onRevoke={() => void revoke([e])}
                />
              );
            })}
          </ul>
        </div>
      )}

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

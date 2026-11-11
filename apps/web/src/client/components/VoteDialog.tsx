import { useEffect, useState } from "react";
import type { VoteResponse } from "../../shared/api.js";
import { ApiRequestError, castVote, fetchVote } from "../lib/api.js";
import { Modal } from "./Modal.js";

interface VoteDialogProps {
  open: boolean;
  onClose: () => void;
  /** Gets a session first if needed (voting requires one). */
  ensureSession: () => Promise<boolean>;
  /** Opens Settings to connect a holder wallet. */
  onConnect: () => void;
}

const fmt = (whole: string) => BigInt(whole).toLocaleString("en-US");

/** $MOFU holder roadmap vote: live results for everyone, one vote per connected holder wallet. */
export function VoteDialog({ open, onClose, ensureSession, onConnect }: VoteDialogProps) {
  const [data, setData] = useState<VoteResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setNote(null);
    fetchVote()
      .then(setData)
      .catch(() => setNote({ kind: "bad", text: "Couldn't load the vote right now." }));
  }, [open]);

  const vote = async (option: string) => {
    setNote(null);
    setBusy(option);
    try {
      if (!(await ensureSession())) return;
      const next = await castVote(option);
      setData(next);
      setNote({ kind: "ok", text: "Vote counted. You can change it while the vote is open." });
    } catch (err) {
      setNote({
        kind: "bad",
        text: err instanceof ApiRequestError ? err.message : "Couldn't save your vote. Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const results = new Map(data?.results.map((r) => [r.id, r]));
  return (
    <Modal open={open} title="Holder vote" onClose={onClose}>
      <div className="vote">
        {!data ? (
          <p className="muted">{note?.text ?? "Loading the vote…"}</p>
        ) : (
          <>
            <p className="vote-question">{data.round.question}</p>
            <p className="muted small">
              $MOFU holders decide. Each vote counts with the wallet's $MOFU balance when results
              are tallied, so moving tokens between wallets can't vote twice.{" "}
              {data.totalVoters > 0
                ? `${data.totalVoters} wallet${data.totalVoters === 1 ? "" : "s"} voted with ${fmt(data.totalWeight)} $MOFU.`
                : "No votes yet. Be the first."}
            </p>
            <ul className="vote-options">
              {data.round.options.map((o) => {
                const r = results.get(o.id);
                const mine = data.mine === o.id;
                return (
                  <li key={o.id} className={mine ? "vote-option vote-option--mine" : "vote-option"}>
                    <div className="vote-head">
                      <strong>{o.title}</strong>
                      <span className="vote-pct">
                        {r ? `${Number(r.percent.toFixed(1))}%` : "0%"}
                      </span>
                    </div>
                    <p className="muted small">{o.body}</p>
                    <div className="vote-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(r?.percent ?? 0, 0.5)}%` }} />
                    </div>
                    <div className="vote-foot">
                      <span className="muted small">
                        {r?.voters ?? 0} vote{r?.voters === 1 ? "" : "s"}
                        {r && r.weight !== "0" ? ` · ${fmt(r.weight)} $MOFU` : ""}
                      </span>
                      {data.canVote && (
                        <button
                          type="button"
                          className={mine ? "pill-button" : "ghost-button"}
                          onClick={() => void vote(o.id)}
                          disabled={busy !== null || mine}
                        >
                          {mine ? "Your vote" : busy === o.id ? "Saving…" : "Vote"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {!data.canVote && data.round.open && (
              <div className="token-locked">
                <p>
                  <strong>Only $MOFU holders vote.</strong> Connect a wallet that holds{" "}
                  {fmt(data.minTokens)}+ $MOFU to cast yours. Results are open to everyone.
                </p>
                <button type="button" className="ghost-button" onClick={onConnect}>
                  Connect wallet
                </button>
              </div>
            )}
            {!data.round.open && <p className="muted">This vote is closed. Thanks for voting.</p>}
            {note && <p className={`status status--${note.kind}`}>{note.text}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

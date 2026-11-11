import { useState } from "react";
import type { HolderPerks, HolderStatus } from "../../shared/api.js";
import { ApiRequestError, holderDisconnect } from "../lib/api.js";
import {
  connectHolderWallet,
  formatTokens,
  injectedWallet,
  shortAddress,
  WalletError,
} from "../lib/wallet.js";

interface HolderSectionProps {
  perks: HolderPerks;
  status: HolderStatus | null;
  freeDailyLimit: number;
  /** Gets a session first if needed (connecting requires one). */
  ensureSession: () => Promise<boolean>;
  /** Called after connecting or disconnecting, so the usage counter refreshes. */
  onChange: () => void;
}

export function HolderSection({
  perks,
  status,
  freeDailyLimit,
  ensureSession,
  onChange,
}: HolderSectionProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  // undefined: show what the server last reported; null: just disconnected.
  const [override, setOverride] = useState<HolderStatus | null | undefined>(undefined);
  const shown = override === undefined ? status : override;
  const min = formatTokens(perks.minTokens);
  const hasWallet = typeof window !== "undefined" && injectedWallet() !== null;

  const connect = async () => {
    setNote(null);
    setBusy(true);
    try {
      if (!(await ensureSession())) return;
      const result = await connectHolderWallet();
      setOverride(result);
      setNote(
        result.eligible
          ? { kind: "ok", text: `Holder perks are on: ${perks.dailyLimit} messages a day.` }
          : result.balance === null
            ? { kind: "bad", text: "Connected, but your balance couldn't be read right now." }
            : { kind: "bad", text: `Connected. You need at least ${min} $MOFU for holder perks.` },
      );
      onChange();
    } catch (err) {
      setNote({
        kind: "bad",
        text:
          err instanceof WalletError || err instanceof ApiRequestError
            ? err.message
            : "Couldn't connect. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await holderDisconnect();
    } catch {
      // The cookie expires on its own; nothing else to undo.
    }
    setOverride(null);
    setNote(null);
    setBusy(false);
    onChange();
  };

  return (
    <section className="holder">
      <h3>$MOFU holder perks</h3>
      <p className="muted">
        Hold at least {min} $MOFU on {perks.chainName} and get {perks.dailyLimit} free messages a
        day instead of {freeDailyLimit}. Connecting only asks your wallet to sign a message: no
        transaction, no gas, no approvals. Mofu will never ask for your seed phrase.
      </p>

      {shown ? (
        <div className="holder-card">
          <p>
            <span className="muted">Wallet</span> <code>{shortAddress(shown.address)}</code>
          </p>
          <p>
            <span className="muted">Balance</span>{" "}
            {shown.balance === null
              ? "couldn't be read right now"
              : `${formatTokens(shown.balance)} $MOFU`}
          </p>
          <p className={shown.eligible ? "status status--ok" : "muted small"}>
            {shown.eligible
              ? `Holder perks active: ${perks.dailyLimit} messages a day.`
              : shown.balance === null
                ? `The free limit applies until the balance can be read.`
                : `Below ${min} $MOFU, so the free limit applies.`}
          </p>
          <div className="input-row">
            <button type="button" className="ghost-button" onClick={connect} disabled={busy}>
              {busy ? "Checking…" : "Check again"}
            </button>
            <button
              type="button"
              className="ghost-button danger"
              onClick={disconnect}
              disabled={busy}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : hasWallet ? (
        <button type="button" className="ghost-button" onClick={connect} disabled={busy}>
          {busy ? "Waiting for your wallet…" : "Connect wallet"}
        </button>
      ) : (
        <p className="muted small">
          No wallet found in this browser. Install a browser wallet such as MetaMask or Rabby, or on
          a phone open mofu.works/app in your wallet app's built-in browser.
        </p>
      )}

      {note && <p className={`status status--${note.kind}`}>{note.text}</p>}
      <p className="muted small">
        Official contract: <code className="holder-ca">{perks.token}</code>
      </p>
    </section>
  );
}

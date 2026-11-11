import { useEffect, useState } from "react";
import { CURATED_MODELS, type HolderPerks, type HolderStatus } from "../../shared/api.js";
import { ApiRequestError, checkKey } from "../lib/api.js";
import type { Settings } from "../lib/storage.js";
import { HolderSection } from "./HolderSection.js";
import { Modal } from "./Modal.js";

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  defaultModel: string;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  /** Gets a session first if needed (the key check endpoint requires one). */
  ensureSession: () => Promise<boolean>;
  /** $MOFU holder perks, when the server has them on. */
  holderPerks: HolderPerks | null;
  holder: HolderStatus | null;
  freeDailyLimit: number;
  onHolderChange: () => void;
  onOpenVote: () => void;
}

type KeyStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; note: string }
  | { kind: "bad"; note: string };

const CUSTOM = "__custom__";

export function SettingsDialog({
  open,
  settings,
  defaultModel,
  onClose,
  onSave,
  ensureSession,
  holderPerks,
  holder,
  freeDailyLimit,
  onHolderChange,
  onOpenVote,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<KeyStatus>({ kind: "idle" });
  const isCurated = CURATED_MODELS.some((m) => m.id === (draft.byokModel || defaultModel));
  const [customModel, setCustomModel] = useState(!isCurated);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setStatus({ kind: "idle" });
      setCustomModel(!CURATED_MODELS.some((m) => m.id === (settings.byokModel || defaultModel)));
    }
  }, [open, settings, defaultModel]);

  const verify = async () => {
    const key = draft.byokKey.trim();
    if (!key) return;
    setStatus({ kind: "checking" });
    if (!(await ensureSession())) {
      setStatus({ kind: "idle" });
      return;
    }
    try {
      const res = await checkKey(key);
      if (!res.valid) setStatus({ kind: "bad", note: "OpenRouter didn't accept this key." });
      else
        setStatus({
          kind: "ok",
          note:
            typeof res.limitRemaining === "number"
              ? `Key works. $${res.limitRemaining.toFixed(2)} credit left on it.`
              : "Key works.",
        });
    } catch (err) {
      setStatus({
        kind: "bad",
        note: err instanceof ApiRequestError ? err.message : "Couldn't check the key.",
      });
    }
  };

  const hasKey = draft.byokKey.trim().length > 0;

  return (
    <Modal open={open} title="Settings" onClose={onClose}>
      <form
        className="settings"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...draft,
            byokKey: draft.byokKey.trim(),
            byokModel: hasKey ? draft.byokModel.trim() : "",
          });
        }}
      >
        {holderPerks && (
          <HolderSection
            perks={holderPerks}
            status={holder}
            freeDailyLimit={freeDailyLimit}
            ensureSession={ensureSession}
            onChange={onHolderChange}
            onOpenVote={onOpenVote}
          />
        )}

        <section>
          <h3>Your own OpenRouter key</h3>
          <p className="muted">
            Optional. With your own key there's no daily limit and you can pick any model. The key
            is stored only in this browser and sent with each message to call the model. Our server
            never stores or logs it.
          </p>
          <label htmlFor="byok-key">API key</label>
          <div className="input-row">
            <input
              id="byok-key"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-or-…"
              value={draft.byokKey}
              onChange={(e) => {
                setDraft({ ...draft, byokKey: e.target.value });
                setStatus({ kind: "idle" });
              }}
            />
            <button type="button" className="ghost-button" onClick={() => setShowKey(!showKey)}>
              {showKey ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={verify}
              disabled={!hasKey || status.kind === "checking"}
            >
              {status.kind === "checking" ? "Checking…" : "Check"}
            </button>
          </div>
          {status.kind === "ok" && <p className="status status--ok">{status.note}</p>}
          {status.kind === "bad" && <p className="status status--bad">{status.note}</p>}
          <p className="muted small">
            Get a key at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
              openrouter.ai/keys
            </a>
            .
          </p>

          <label htmlFor="byok-model">Model</label>
          <select
            id="byok-model"
            disabled={!hasKey}
            value={customModel ? CUSTOM : draft.byokModel || defaultModel}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustomModel(true);
              else {
                setCustomModel(false);
                setDraft({ ...draft, byokModel: e.target.value });
              }
            }}
          >
            {CURATED_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={CUSTOM}>Other model ID…</option>
          </select>
          {customModel && hasKey && (
            <input
              aria-label="Custom model ID"
              placeholder="vendor/model, e.g. openai/gpt-oss-20b"
              value={draft.byokModel}
              onChange={(e) => setDraft({ ...draft, byokModel: e.target.value })}
            />
          )}
          {!hasKey && <p className="muted small">Add your own key to choose a model.</p>}
        </section>

        <footer className="modal-footer">
          {settings.byokKey && (
            <button
              type="button"
              className="ghost-button danger"
              onClick={() => onSave({ ...draft, byokKey: "", byokModel: "" })}
            >
              Remove key
            </button>
          )}
          <button type="submit" className="pill-button">
            Save
          </button>
        </footer>
      </form>
    </Modal>
  );
}

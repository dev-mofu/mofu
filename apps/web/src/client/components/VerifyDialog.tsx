import { useEffect, useRef, useState } from "react";
import { loadTurnstile } from "../lib/turnstile.js";
import { Modal } from "./Modal.js";

interface VerifyDialogProps {
  open: boolean;
  siteKey: string;
  theme: "light" | "dark";
  onToken: (token: string) => void;
  onCancel: () => void;
}

/** Shows Cloudflare Turnstile. Usually it passes on its own in a second or two. */
export function VerifyDialog({ open, siteKey, theme, onToken, onCancel }: VerifyDialogProps) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !siteKey) return;
    let widgetId: string | null = null;
    let cancelled = false;
    setError(null);
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          theme,
          callback: onToken,
          "error-callback": () => setError("Verification failed. Reload the page and try again."),
          "expired-callback": () => setError("Verification expired. Please try again."),
        });
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [open, siteKey, theme, onToken]);

  return (
    <Modal open={open} title="Quick check" onClose={onCancel}>
      <p className="muted">Mofu is free to use. This one-time check keeps bots from using it up.</p>
      <div ref={container} className="turnstile" />
      {error && <p className="status status--bad">{error}</p>}
    </Modal>
  );
}

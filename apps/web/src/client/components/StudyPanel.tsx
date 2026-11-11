import { useRef, useState, type FormEvent } from "react";
import type { LoadedDocument } from "../lib/study.js";

interface StudyPanelProps {
  loaded: LoadedDocument | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Page/section cap for this user (lower on the free tier). */
  maxPages: number;
  onFile: (file: File, range?: { from: number; to: number }) => void;
  onUrl: (url: string) => void;
  onAction: (prompt: string) => void;
  onClear: () => void;
}

export const STUDY_ACTIONS: Array<{ label: string; prompt: string }> = [
  { label: "Summary", prompt: "Summarize this document (short: 5 bullet points), citing pages." },
  {
    label: "Detailed summary",
    prompt: "Give me a detailed, structured summary of this document, citing pages.",
  },
  {
    label: "Explain like I'm 12",
    prompt: "Explain the main ideas of this document like I'm 12, with an everyday example.",
  },
  { label: "Flashcards", prompt: "Make 15 flashcards covering the key facts of this document." },
  {
    label: "Quiz me",
    prompt: "Quiz me on this document: 6 questions, mixing multiple choice and short answer.",
  },
];

export function StudyPanel(props: StudyPanelProps) {
  const { loaded, loading, error } = props;
  const [url, setUrl] = useState("");
  const [range, setRange] = useState({ from: 1, to: props.maxPages });
  const input = useRef<HTMLInputElement>(null);

  if (loaded) {
    const d = loaded.doc;
    const first = d.parts[0]?.number;
    const last = d.parts.at(-1)?.number;
    return (
      <section className="data-card" aria-label="Loaded document">
        <div className="data-card-main">
          <div className="repo-name">{d.title}</div>
          <p className="muted small">
            {d.kind === "pdf"
              ? `PDF, pages ${first}–${last} of ${d.totalParts}`
              : `${d.parts.length} sections`}{" "}
            · {d.words.toLocaleString()} words{d.url ? ` · ${new URL(d.url).hostname}` : ""}
          </p>
          {loaded.truncated && (
            <p className="data-problems">
              Only part of the document is loaded to stay within limits. Load another page range for
              the rest
              {props.maxPages < 300 ? ", or add your own key in Settings for longer documents" : ""}
              .
            </p>
          )}
          <div className="study-actions">
            {STUDY_ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                className="suggestion"
                disabled={props.busy}
                onClick={() => props.onAction(a.prompt)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <div className="scan-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={props.onClear}
            disabled={props.busy}
          >
            Change document
          </button>
        </div>
      </section>
    );
  }

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) props.onUrl(url.trim());
  };

  return (
    <div className="data-drop">
      <p>
        <strong>Upload a PDF, text or Markdown file</strong> or paste a link to an article.
      </p>
      <div className="study-inputs">
        <button
          type="button"
          className="pill-button"
          disabled={loading}
          onClick={() => input.current?.click()}
        >
          Choose file
        </button>
        <label className="study-range">
          Pages{" "}
          <input
            type="number"
            min={1}
            value={range.from}
            onChange={(e) =>
              setRange((r) => ({ ...r, from: Math.max(1, Number(e.target.value) || 1) }))
            }
            aria-label="First page"
          />
          –
          <input
            type="number"
            min={1}
            value={range.to}
            onChange={(e) =>
              setRange((r) => ({ ...r, to: Math.max(1, Number(e.target.value) || 1) }))
            }
            aria-label="Last page"
          />
        </label>
        <form className="repo-form study-url" onSubmit={submitUrl}>
          <label htmlFor="study-url" className="visually-hidden">
            Article link
          </label>
          <input
            id="study-url"
            type="text"
            inputMode="url"
            placeholder="https://… article link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button type="submit" className="ghost-button" disabled={loading || !url.trim()}>
            Load link
          </button>
        </form>
      </div>
      <p className="muted small">
        Up to {props.maxPages} pages at a time. PDFs are read in your browser; Mofu only reads the
        pages it needs. Scanned PDFs (images of text) aren't supported yet.
      </p>
      <input
        ref={input}
        type="file"
        accept=".pdf,.txt,.md,.markdown,text/plain,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const span = Math.min(range.to - range.from + 1, props.maxPages);
          props.onFile(f, { from: range.from, to: range.from + Math.max(span, 1) - 1 });
        }}
      />
      {loading && (
        <p className="status" role="status">
          Reading…
        </p>
      )}
      {error && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

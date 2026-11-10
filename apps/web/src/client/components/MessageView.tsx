import { lazy, Suspense } from "react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";

const LazyMarkdown = lazy(() => import("./Markdown.js"));

const TOOL_LABELS: Record<string, string> = {
  wikipedia_summary: "Wikipedia",
  define_word: "Dictionary",
  save_memory: "Memory",
};

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function Markdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="markdown markdown--plain">{text}</div>}>
      <LazyMarkdown text={text} />
    </Suspense>
  );
}

function shorten(value: unknown, max = 2000): string {
  // Tool input is undefined while it's still streaming; JSON.stringify(undefined) is undefined.
  if (value === undefined) return "…";
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function toolSubject(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const subject = i.title ?? i.word ?? i.fact;
  return typeof subject === "string" ? subject : "";
}

function ToolRow({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;
  const subject = toolSubject(name, part.input);
  const state =
    part.state === "output-available"
      ? "done"
      : part.state === "output-error"
        ? "error"
        : part.state === "output-denied"
          ? "declined"
          : "running";
  const output =
    part.state === "output-available" ? (part.output as Record<string, unknown>) : null;
  const wikiUrl =
    name === "wikipedia_summary" && output?.found === true ? String(output.url) : null;

  return (
    <div className="tool">
      <details>
        <summary>
          <span className={`tool-dot tool-dot--${state}`} aria-hidden="true" />
          <span className="tool-label">{label}</span>
          {subject && <span className="tool-subject">{subject}</span>}
          <span className="visually-hidden">({state})</span>
        </summary>
        <div className="tool-detail">
          <div className="tool-detail-heading">Input</div>
          <pre>{shorten(part.input)}</pre>
          {part.state === "output-available" && (
            <>
              <div className="tool-detail-heading">Result</div>
              <pre>{shorten(part.output)}</pre>
            </>
          )}
          {part.state === "output-error" && <p className="tool-error">{part.errorText}</p>}
        </div>
      </details>
      {wikiUrl && (
        <p className="attribution">
          Source:{" "}
          <a href={wikiUrl} target="_blank" rel="noopener noreferrer">
            Wikipedia — {String(output?.title ?? "article")}
          </a>{" "}
          (CC BY-SA 4.0)
        </p>
      )}
    </div>
  );
}

interface MessageViewProps {
  message: UIMessage;
  /** Returns IDs/versions in the text that the source data doesn't contain. */
  verify?: (text: string) => { ids: string[]; versions: string[] };
}

export function MessageView({ message, verify }: MessageViewProps) {
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  if (message.role === "user") {
    return (
      <div className="message message--user">
        <div className="bubble">{text}</div>
      </div>
    );
  }
  const unverified = verify ? verify(text) : null;
  const flagged = unverified ? [...unverified.ids, ...unverified.versions] : [];
  return (
    <div className="message message--assistant">
      {message.parts.map((part, i) => {
        if (part.type === "text") return <Markdown key={i} text={part.text} />;
        if (isToolUIPart(part)) return <ToolRow key={part.toolCallId} part={part} />;
        return null;
      })}
      {flagged.length > 0 && (
        <p className="verify-warning" role="note">
          ⚠ Not in the scan data, so double-check: {flagged.join(", ")}
        </p>
      )}
    </div>
  );
}

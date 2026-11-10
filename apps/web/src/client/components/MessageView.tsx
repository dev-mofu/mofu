import { lazy, Suspense } from "react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";

const LazyMarkdown = lazy(() => import("./Markdown.js"));

const TOOL_LABELS: Record<string, string> = {
  wikipedia_summary: "Wikipedia",
  define_word: "Dictionary",
  save_memory: "Memory",
  run_python: "Python",
  export_csv: "Export",
  fx_rates: "Exchange rates",
  public_holidays: "Holidays",
  historical_weather: "Weather",
  country_info: "Countries",
  economic_indicator: "World Bank",
};

/** Charts and exports from browser-run tools, by tool call. */
export interface ToolArtifacts {
  figures: Map<string, string[]>;
  exports: Map<string, { filename: string; csv: string }>;
  download: (filename: string, text: string) => void;
}

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
  if (name === "run_python" && typeof i.code === "string") {
    return (
      i.code
        .split("\n")
        .find((l) => l.trim() && !l.trim().startsWith("#"))
        ?.trim() ?? ""
    );
  }
  const subject =
    i.title ?? i.word ?? i.fact ?? i.filename ?? i.place ?? i.indicator ?? i.base ?? i.country;
  return typeof subject === "string" ? subject : "";
}

function ToolRow({ part, artifacts }: { part: ToolPart; artifacts?: ToolArtifacts }) {
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
          <div className="tool-detail-heading">{name === "run_python" ? "Code" : "Input"}</div>
          <pre>
            {name === "run_python" && typeof (part.input as { code?: unknown })?.code === "string"
              ? (part.input as { code: string }).code
              : shorten(part.input)}
          </pre>
          {part.state === "output-available" && (
            <>
              <div className="tool-detail-heading">Result</div>
              <pre>{shorten(part.output)}</pre>
            </>
          )}
          {part.state === "output-error" && <p className="tool-error">{part.errorText}</p>}
        </div>
      </details>
      {(artifacts?.figures.get(part.toolCallId) ?? []).map((png, i) => (
        <figure key={i} className="chart">
          <img src={`data:image/png;base64,${png}`} alt={`Chart ${i + 1} from the analysis`} />
          <figcaption>
            <a
              href={`data:image/png;base64,${png}`}
              download={`mofu-chart-${part.toolCallId.slice(-6)}-${i + 1}.png`}
            >
              Download PNG
            </a>
          </figcaption>
        </figure>
      ))}
      {artifacts?.exports.get(part.toolCallId) && (
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            const file = artifacts.exports.get(part.toolCallId)!;
            artifacts.download(file.filename, file.csv);
          }}
        >
          Download {artifacts.exports.get(part.toolCallId)!.filename}
        </button>
      )}
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
  artifacts?: ToolArtifacts;
}

export function MessageView({ message, verify, artifacts }: MessageViewProps) {
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
        if (isToolUIPart(part))
          return <ToolRow key={part.toolCallId} part={part} {...(artifacts && { artifacts })} />;
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

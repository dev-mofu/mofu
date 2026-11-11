import { useRef, useState, type FormEvent } from "react";
import type { SpecProblem } from "@mofu/core/apiforge";
import type { LoadedApi } from "../lib/apiforge.js";

interface ApiPanelProps {
  api: LoadedApi | null;
  loading: boolean;
  error: { message: string; problems: SpecProblem[] } | null;
  busy: boolean;
  onText: (name: string, text: string) => void;
  onUrl: (url: string) => void;
  onGenerate: (what: "tests" | "docs") => void;
  /** A second version to compare against (file or pasted text). */
  onCompare: (name: string, text: string) => void;
  onClear: () => void;
}

const ACCEPT = ".json,.yaml,.yml,application/json,application/yaml,text/yaml";

/** Reads a file and hands its text over; shows nothing itself. */
function useFilePicker(onText: (name: string, text: string) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void f.text().then((t) => onText(f.name, t));
      }}
    />
  );
  return { open: () => input.current?.click(), element };
}

function Problems({ error }: { error: NonNullable<ApiPanelProps["error"]> }) {
  return (
    <div className="status status--bad" role="alert">
      <p>{error.problems.length ? "The spec has problems:" : error.message}</p>
      {error.problems.length > 0 && (
        <ul className="spec-problems">
          {error.problems.slice(0, 12).map((p, i) => (
            <li key={i}>
              {p.path && <code>{p.path}</code>} {p.message}
            </li>
          ))}
          {error.problems.length > 12 && <li>… and {error.problems.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}

export function ApiPanel(props: ApiPanelProps) {
  const { api, loading, error, busy } = props;
  const [url, setUrl] = useState("");
  const [pasting, setPasting] = useState<"spec" | "compare" | null>(null);
  const [pasted, setPasted] = useState("");
  const main = useFilePicker(props.onText);
  const compare = useFilePicker(props.onCompare);

  const pasteBox = pasting && (
    <div className="spec-paste">
      <label htmlFor="spec-paste" className="visually-hidden">
        Spec text
      </label>
      <textarea
        id="spec-paste"
        rows={8}
        placeholder={
          pasting === "spec"
            ? "Paste an OpenAPI or Swagger spec (JSON or YAML)"
            : "Paste the other version of the spec"
        }
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
      />
      <div className="spec-paste-actions">
        <button
          type="button"
          className="pill-button"
          disabled={!pasted.trim() || loading}
          onClick={() => {
            (pasting === "spec" ? props.onText : props.onCompare)("pasted spec", pasted);
            setPasting(null);
            setPasted("");
          }}
        >
          {pasting === "spec" ? "Load spec" : "Compare"}
        </button>
        <button type="button" className="ghost-button" onClick={() => setPasting(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  if (api) {
    const groups = new Set(api.index.endpoints.map((e) => e.tags[0])).size;
    return (
      <section className="data-card" aria-label="Loaded API spec">
        <div className="data-card-main">
          <div className="repo-name">
            {api.index.title} {api.index.version}
          </div>
          <p className="muted small">
            {api.index.specVersion.startsWith("2") ? "Swagger" : "OpenAPI"} {api.index.specVersion}{" "}
            · valid · {api.index.endpoints.length} endpoints in {groups}{" "}
            {groups === 1 ? "group" : "groups"} · {api.name}
          </p>
          {api.warnings.length > 0 && (
            <ul className="data-problems">
              {api.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}
          <div className="study-actions">
            <button
              type="button"
              className="suggestion"
              disabled={busy}
              onClick={() => props.onGenerate("tests")}
            >
              Generate tests
            </button>
            <button
              type="button"
              className="suggestion"
              disabled={busy}
              onClick={() => props.onGenerate("docs")}
            >
              Generate docs
            </button>
            <button
              type="button"
              className="suggestion"
              disabled={busy || loading}
              onClick={compare.open}
            >
              Compare with another version
            </button>
            <button
              type="button"
              className="link-button small"
              disabled={busy || loading}
              onClick={() => setPasting("compare")}
            >
              or paste it
            </button>
          </div>
          {pasteBox}
          {error && <Problems error={error} />}
          {compare.element}
        </div>
        <div className="scan-actions">
          <button type="button" className="ghost-button" onClick={props.onClear} disabled={busy}>
            Change spec
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
        <strong>Load an OpenAPI 3.x or Swagger 2.0 spec</strong> (JSON or YAML). It's parsed and
        validated in your browser.
      </p>
      <div className="study-inputs">
        <button type="button" className="pill-button" disabled={loading} onClick={main.open}>
          Upload spec
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={loading}
          onClick={() => setPasting("spec")}
        >
          Paste
        </button>
        <form className="repo-form study-url" onSubmit={submitUrl}>
          <label htmlFor="spec-url" className="visually-hidden">
            Spec link
          </label>
          <input
            id="spec-url"
            type="text"
            inputMode="url"
            placeholder="https://…/openapi.json"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button type="submit" className="ghost-button" disabled={loading || !url.trim()}>
            Load link
          </button>
        </form>
      </div>
      {pasteBox}
      {main.element}
      {loading && (
        <p className="status" role="status">
          Reading the spec…
        </p>
      )}
      {error && <Problems error={error} />}
    </div>
  );
}

import { useRef, useState, type DragEvent } from "react";
import type { DatasetProfile } from "@mofu/core/web";

export interface LoadedDataset {
  name: string;
  profile: DatasetProfile;
}

interface DataPanelProps {
  dataset: LoadedDataset | null;
  loading: boolean;
  progress: string;
  error: string | null;
  busy: boolean;
  canDownloadReport: boolean;
  onFile: (file: File) => void;
  onClear: () => void;
  onReport: () => void;
  onDownloadReport: () => void;
}

export const MAX_DATA_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".csv,.tsv,.txt,.json,.xlsx,.xlsm";

export function DataPanel(props: DataPanelProps) {
  const { dataset, loading, progress, error } = props;
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) props.onFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files);
  };

  if (dataset) {
    const p = dataset.profile;
    return (
      <section className="data-card" aria-label="Loaded dataset">
        <div className="data-card-main">
          <div className="repo-name">{dataset.name}</div>
          <p className="muted small">
            {p.rows.toLocaleString()} rows × {p.columns.length} columns · runs in your browser
          </p>
          <ul className="data-columns">
            {p.columns.slice(0, 14).map((c) => (
              <li
                key={c.name}
                className={`col col--${c.kind}`}
                title={`${c.dtype}, ${c.nulls} missing`}
              >
                {c.name}
              </li>
            ))}
            {p.columns.length > 14 && <li className="col">+{p.columns.length - 14} more</li>}
          </ul>
          {p.problems.length > 0 && (
            <ul className="data-problems">
              {p.problems.slice(0, 5).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="scan-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={props.onReport}
            disabled={props.busy}
          >
            Generate report
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={props.onDownloadReport}
            disabled={!props.canDownloadReport}
          >
            Download report
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={props.onClear}
            disabled={props.busy}
          >
            Change file
          </button>
        </div>
      </section>
    );
  }

  return (
    <div
      className={`data-drop${dragging ? " data-drop--active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p>
        <strong>Drop a CSV, Excel or JSON file</strong> or{" "}
        <button
          type="button"
          className="link-button"
          onClick={() => input.current?.click()}
          disabled={loading}
        >
          choose one
        </button>
        . Up to 20 MB.
      </p>
      <p className="muted small">
        The file never leaves your browser: Python runs here, and Mofu only sees a profile and the
        results of each step.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {loading && (
        <p className="status" role="status">
          {progress || "Loading…"}
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

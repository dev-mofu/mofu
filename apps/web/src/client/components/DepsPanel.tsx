import { useRef, useState, type FormEvent } from "react";
import { MANIFEST_PATTERN, scanDependencies, type ScanReport } from "@mofu/core/web";
import { fetchGitHubFiles } from "../lib/github.js";

interface DepsPanelProps {
  scanning: boolean;
  onScanStart: () => void;
  onScanned: (report: ScanReport, source: string) => void;
  onError: () => void;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Upload manifests or point at a public repo; the scan runs entirely in the browser. */
export function DepsPanel({ scanning, onScanStart, onScanned, onError }: DepsPanelProps) {
  const [url, setUrl] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (
    source: string,
    load: () => Promise<Array<{ path: string; text: string }>>,
  ) => {
    setError(null);
    onScanStart();
    try {
      setProgress("Reading files…");
      const files = await load();
      if (files.length === 0) {
        throw new Error(
          "No package.json, package-lock.json, requirements*.txt or pyproject.toml found.",
        );
      }
      const report = await scanDependencies(files, { onProgress: setProgress });
      onScanned(report, source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The scan failed. Please try again.");
      onError();
    } finally {
      setProgress("");
    }
  };

  const fromGitHub = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || scanning) return;
    void run(url.trim(), async () => {
      const repo = await fetchGitHubFiles(url.trim(), MANIFEST_PATTERN);
      return repo.files;
    });
  };

  const fromUpload = (list: FileList | null) => {
    if (!list?.length) return;
    const picked = Array.from(list);
    void run(picked.map((f) => f.name).join(", "), async () => {
      const usable = picked.filter(
        (f) => MANIFEST_PATTERN.test(f.name) && f.size <= MAX_FILE_BYTES,
      );
      return Promise.all(usable.map(async (f) => ({ path: f.name, text: await f.text() })));
    });
  };

  return (
    <div className="deps-panel">
      <form className="repo-form" onSubmit={fromGitHub}>
        <label htmlFor="deps-url" className="visually-hidden">
          Public GitHub repository URL
        </label>
        <input
          id="deps-url"
          type="text"
          inputMode="url"
          placeholder="Public GitHub URL to scan, e.g. github.com/expressjs/express"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={scanning}
          spellCheck={false}
        />
        <button type="submit" className="pill-button" disabled={scanning || !url.trim()}>
          Scan
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={scanning}
          onClick={() => fileInput.current?.click()}
        >
          Upload files
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".json,.txt,.toml"
          onChange={(e) => {
            fromUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </form>
      <p className="muted small deps-hint">
        Supports npm (<code>package.json</code> + <code>package-lock.json</code>) and Python (
        <code>requirements.txt</code>, <code>pyproject.toml</code>). Files stay in your browser;
        only package names and versions are sent to OSV and deps.dev.
      </p>
      {scanning && progress && (
        <p className="status" role="status">
          {progress}
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

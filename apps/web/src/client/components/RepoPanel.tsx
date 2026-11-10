import { useState, type FormEvent } from "react";
import { GitHubError, type LoadedRepo } from "../lib/github.js";

interface RepoPanelProps {
  repo: LoadedRepo | null;
  loading: boolean;
  error: GitHubError | null;
  onLoad: (url: string) => void;
  onClear: () => void;
}

function errorText(error: GitHubError): string {
  if (error.kind === "rate_limit" && error.resetAt) {
    const at = error.resetAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${error.message} It resets at ${at}.`;
  }
  return error.message;
}

export function RepoPanel({ repo, loading, error, onLoad, onClear }: RepoPanelProps) {
  const [url, setUrl] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !loading) onLoad(url.trim());
  };

  if (repo) {
    const o = repo.overview;
    return (
      <section className="repo-card" aria-label="Loaded repository">
        <div className="repo-card-main">
          <a href={repo.url} target="_blank" rel="noopener noreferrer" className="repo-name">
            {repo.fullName}
          </a>
          {repo.description && <p className="muted repo-desc">{repo.description}</p>}
          <ul className="repo-facts">
            <li>★ {repo.stars.toLocaleString()}</li>
            <li>{o.fileCount.toLocaleString()} files</li>
            {o.languages[0] && (
              <li>
                {o.languages
                  .slice(0, 3)
                  .map((l) => l.language)
                  .join(", ")}
              </li>
            )}
            {o.test && (
              <li>
                tests: <code>{o.test.command}</code>
              </li>
            )}
            <li>branch: {repo.branch}</li>
          </ul>
        </div>
        <button type="button" className="ghost-button" onClick={onClear}>
          Change repo
        </button>
      </section>
    );
  }

  return (
    <form className="repo-form" onSubmit={submit}>
      <label htmlFor="repo-url" className="visually-hidden">
        Public GitHub repository URL
      </label>
      <input
        id="repo-url"
        type="text"
        inputMode="url"
        placeholder="Paste a public GitHub URL, e.g. github.com/honojs/hono"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
        spellCheck={false}
      />
      <button type="submit" className="pill-button" disabled={loading || !url.trim()}>
        {loading ? "Reading…" : "Load"}
      </button>
      {error && (
        <p className="status status--bad repo-error" role="alert">
          {errorText(error)}
        </p>
      )}
    </form>
  );
}

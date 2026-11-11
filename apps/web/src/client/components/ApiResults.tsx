import { lazy, Suspense, useState } from "react";
import type { SpecChange } from "@mofu/core/apiforge";
import { downloadText } from "../lib/data-tools.js";
import { loadApiForge, type ApiDiffState, type LoadedApi } from "../lib/apiforge.js";

const LazyMarkdown = lazy(() => import("./Markdown.js"));

interface ApiResultsProps {
  api: LoadedApi;
  diff: ApiDiffState | null;
  busy: boolean;
  /** Bumped when the workspace gains cases or descriptions. */
  version: number;
  onExplainDiff: () => void;
  onClearDiff: () => void;
}

const fileBase = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "api";

function ChangeTable({ changes, breaking }: { changes: SpecChange[]; breaking: boolean }) {
  if (!changes.length) return <p className="muted small">None.</p>;
  return (
    <div className="scan-table-wrap">
      <table className="scan-table api-table">
        <thead>
          <tr>
            <th scope="col">Endpoint</th>
            <th scope="col">Where</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i} className={breaking ? "row--bad" : ""}>
              <td>
                <code>{c.endpoint}</code>
              </td>
              <td>{c.location}</td>
              <td>{c.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApiResults({ api, diff, busy, onExplainDiff, onClearDiff }: ApiResultsProps) {
  const [showDocs, setShowDocs] = useState(false);
  const ws = api.workspace;
  const cases = ws.cases;
  const base = fileBase(api.index.title);
  const server = api.index.servers[0] ?? "http://localhost:3000";

  const exportSuite = async (kind: "json" | "vitest" | "http") => {
    const forge = await loadApiForge();
    const suite = ws.suite();
    if (kind === "json")
      downloadText(`${base}.tests.json`, forge.toSuiteJson(suite), "application/json");
    else if (kind === "vitest")
      downloadText(`${base}.test.ts`, forge.toVitestFile(suite, server), "text/plain");
    else downloadText(`${base}.http`, forge.toHttpFile(suite, server), "text/plain");
  };

  return (
    <section className="scan api-results" aria-label="API spec results">
      {diff && (
        <div className="api-block">
          <header className="deck-header">
            <strong>
              {diff.diff.from.version || "old"} → {diff.diff.to.version || "new"} ({diff.name})
            </strong>
            <span className={diff.diff.breaking.length ? "status--bad small" : "status--ok small"}>
              {diff.diff.breaking.length} breaking · {diff.diff.nonBreaking.length} non-breaking
            </span>
          </header>
          <h3 className="api-sub">Breaking</h3>
          <ChangeTable changes={diff.diff.breaking} breaking />
          <h3 className="api-sub">Non-breaking</h3>
          <ChangeTable changes={diff.diff.nonBreaking} breaking={false} />
          <div className="deck-footer">
            <button
              type="button"
              className="pill-button"
              disabled={busy || !diff.diff.breaking.length}
              onClick={onExplainDiff}
            >
              Explain impact
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                void loadApiForge().then((f) =>
                  downloadText(`${base}-diff.md`, f.formatDiffMarkdown(diff.diff), "text/markdown"),
                )
              }
            >
              Download diff (.md)
            </button>
            <button type="button" className="link-button" onClick={onClearDiff}>
              Close diff
            </button>
          </div>
          <p className="muted small">Breaking or not is decided by Mofu's rules, not by AI.</p>
        </div>
      )}

      {cases.length > 0 && (
        <div className="api-block">
          <header className="deck-header">
            <strong>{cases.length} test cases</strong>
            <span className="muted small">checked against the spec</span>
          </header>
          <div className="scan-table-wrap">
            <table className="scan-table api-table">
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col">Request</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Expect</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td title={c.description}>
                      <code>{c.id}</code>
                      <div className="muted small">{c.description}</div>
                    </td>
                    <td>
                      <code>
                        {c.method} {c.endpoint}
                      </code>
                    </td>
                    <td>{c.category.replace("_", " ")}</td>
                    <td>{c.expect.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="deck-footer">
            <button type="button" className="link-button" onClick={() => void exportSuite("json")}>
              JSON
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => void exportSuite("vitest")}
            >
              Vitest file
            </button>
            <button type="button" className="link-button" onClick={() => void exportSuite("http")}>
              .http file
            </button>
          </div>
          <p className="muted small">
            Mofu doesn't send requests to your API from the web. To run these, download the JSON
            into <code>mofu-output/</code> and use the CLI:
          </p>
          <pre className="cli-command">
            npx mofu-cli api test {api.name.endsWith("spec") ? "openapi.yaml" : api.name} --base-url{" "}
            {server}
          </pre>
        </div>
      )}

      {ws.descriptions.size > 0 && (
        <div className="api-block">
          <header className="deck-header">
            <strong>Docs</strong>
            <span className="muted small">
              {ws.descriptions.size} of {api.index.endpoints.length} endpoints described
            </span>
          </header>
          <div className="deck-footer">
            <button
              type="button"
              className="pill-button"
              onClick={() => downloadText(`${base}-docs.md`, ws.docs(), "text/markdown")}
            >
              Download docs (.md)
            </button>
            <button type="button" className="link-button" onClick={() => setShowDocs((s) => !s)}>
              {showDocs ? "Hide preview" : "Preview"}
            </button>
          </div>
          {showDocs && (
            <div className="docs-preview">
              <Suspense fallback={<pre>{ws.docs()}</pre>}>
                <LazyMarkdown text={ws.docs()} />
              </Suspense>
            </div>
          )}
        </div>
      )}

      <details className="api-block" open={!cases.length && !ws.descriptions.size && !diff}>
        <summary>
          <strong>Endpoints</strong>{" "}
          <span className="muted small">({api.index.endpoints.length})</span>
        </summary>
        <div className="scan-table-wrap">
          <table className="scan-table api-table">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">Group</th>
                <th scope="col">Parameters</th>
                <th scope="col">Responses</th>
              </tr>
            </thead>
            <tbody>
              {api.index.endpoints.map((e) => (
                <tr key={e.key}>
                  <td>
                    <code>{e.key}</code>
                    {e.summary && <div className="muted small">{e.summary}</div>}
                  </td>
                  <td>{e.tags[0]}</td>
                  <td className="small">
                    {e.parameters
                      .map((p) => `${p.name}${p.required ? "*" : ""} (${p.in})`)
                      .join(", ") || "—"}
                    {e.requestBody && <div>body{e.requestBody.required ? "*" : ""}</div>}
                  </td>
                  <td className="small">
                    {e.responses.map((r) => r.status).join(" ")}
                    {e.security.length > 0 && (
                      <div className="muted">
                        auth: {e.security.map((s) => s.join("+")).join(" or ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

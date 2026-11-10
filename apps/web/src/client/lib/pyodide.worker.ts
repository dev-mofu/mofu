/// <reference lib="webworker" />
/**
 * Web Worker hosting Pyodide for the Data Analyst. Loaded lazily the first
 * time a file is analyzed. After packages are installed, network APIs are
 * removed so model-written Python can't send the user's data anywhere.
 */
import { handleWorkerRequest, type PyodideLike, type WorkerRequest } from "@mofu/core/web";

const PYODIDE_VERSION = "314.0.7";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const state = { ready: false, networkLocked: false };
const progress = (message: string) => scope.postMessage({ id: -1, progress: message });

function lockNetwork(): void {
  // Pyodide's `js` module exposes the worker's globals to Python.
  const g = scope as unknown as Record<string, unknown>;
  for (const name of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "importScripts",
    "WebTransport",
  ]) {
    try {
      delete g[name];
      g[name] = undefined;
    } catch {
      // Non-configurable in some browsers; the assignment above still shadows it.
    }
  }
}

async function boot(): Promise<PyodideLike> {
  progress("Starting Python (first time takes a moment)…");
  const mod = (await import(/* @vite-ignore */ `${CDN}pyodide.mjs`)) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<unknown>;
  };
  return (await mod.loadPyodide({ indexURL: CDN })) as PyodideLike;
}

const pyodideReady = boot();

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const py = await pyodideReady;
    const value = await handleWorkerRequest(py, req, state, lockNetwork, progress);
    scope.postMessage({ id: req.id, ok: true, value });
  } catch (err) {
    scope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

pyodideReady.then(
  () => scope.postMessage({ id: 0, ok: true, value: "started" }),
  (err: unknown) => scope.postMessage({ id: 0, ok: false, error: String(err) }),
);

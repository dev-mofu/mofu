/**
 * Node worker thread that hosts Pyodide for the CLI's data sandbox.
 * Started with an empty environment (no API keys); network access is removed
 * after packages are installed. Imports use .ts so Node's type stripping can
 * run this file directly from source; tsc rewrites them to .js on build.
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadPyodide } from "pyodide";
import { handleWorkerRequest, type PyodideLike, type WorkerRequest } from "./harness.ts";

const { cacheDir } = workerData as { cacheDir: string };
const port = parentPort!;
const state = { ready: false, networkLocked: false };
const progress = (message: string) => port.postMessage({ id: -1, progress: message });

progress("Starting Python…");
// Python output is captured by the harness; the worker has no usable stdout of its own.
const pyodide = (await loadPyodide({
  packageCacheDir: cacheDir,
  stdout: () => {},
  stderr: () => {},
})) as unknown as PyodideLike;

function lockNetwork(): void {
  // Model-written Python can reach JS globals through Pyodide's `js` module.
  const g = globalThis as Record<string, unknown>;
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) delete g[name];
}

port.on("message", async (req: WorkerRequest) => {
  try {
    const value = await handleWorkerRequest(pyodide, req, state, lockNetwork, progress);
    port.postMessage({ id: req.id, ok: true, value });
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
port.postMessage({ id: 0, ok: true, value: "started" });

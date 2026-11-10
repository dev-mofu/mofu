import { Worker } from "node:worker_threads";
import type { WorkerResponse } from "./harness.js";
import { PythonSandbox, type SandboxOptions, type WorkerPort } from "./sandbox-client.js";

export { SandboxTimeoutError } from "./sandbox-client.js";

export interface NodeSandboxOptions extends SandboxOptions {
  /** Where Pyodide caches downloaded packages (e.g. ~/.mofu/pyodide-cache). */
  cacheDir: string;
}

// From source (tsx/vitest) the worker is the .ts file, run by Node's type stripping.
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./pyodide-node-worker.ts" : "./pyodide-node-worker.js",
  import.meta.url,
);

function nodePort(cacheDir: string): WorkerPort {
  const worker = new Worker(WORKER_URL, {
    workerData: { cacheDir },
    env: {}, // no API keys or other secrets inside the sandbox
    resourceLimits: { maxOldGenerationSizeMb: 2048 },
  });
  return {
    post: (msg) => worker.postMessage(msg),
    listen(onMessage, onFailure) {
      worker.on("message", (m: WorkerResponse) => onMessage(m));
      worker.on("error", (err) => onFailure(err));
      worker.on("exit", () => onFailure(new Error("The Python sandbox stopped.")));
    },
    terminate: () => void worker.terminate(),
  };
}

/** The CLI's sandbox: Pyodide in a Node worker thread. */
export class NodePythonSandbox extends PythonSandbox {
  constructor(opts: NodeSandboxOptions) {
    super(() => nodePort(opts.cacheDir), opts);
  }
}

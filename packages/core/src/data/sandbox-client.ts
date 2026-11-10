import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from "./harness.js";
import type { DatasetProfile, PythonRun } from "./specs.js";

/** A started worker (Node worker thread or browser Web Worker), seen from the host. */
export interface WorkerPort {
  post(msg: WorkerRequest): void;
  /** Called for every message; also reports crashes and exits as errors. */
  listen(onMessage: (msg: WorkerResponse) => void, onFailure: (err: Error) => void): void;
  terminate(): void;
}

export interface SandboxOptions {
  /** Per run_python call. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const LOAD_TIMEOUT_MS = 5 * 60_000; // the first load downloads pandas and matplotlib
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export class SandboxTimeoutError extends Error {
  constructor(ms: number) {
    super(`The code ran longer than ${Math.round(ms / 1000)} seconds and was stopped.`);
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Talks to a Pyodide worker. A run that exceeds the timeout terminates the
 * worker; the next call starts a fresh one and reloads the dataset, so a
 * runaway loop never hangs the app.
 */
export class PythonSandbox {
  private port: WorkerPort | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dataset: { name: string; bytes: Uint8Array } | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly spawn: () => WorkerPort,
    private readonly opts: SandboxOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  private start(): Promise<void> {
    const port = this.spawn();
    this.port = port;
    this.ready = new Promise((resolve, reject) => {
      port.listen(
        (msg) => {
          if ("progress" in msg) return this.opts.onProgress?.(msg.progress);
          if (msg.id === 0) return resolve();
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error));
        },
        (err) => {
          if (this.port === port) this.port = null;
          reject(err);
          this.failAll(err);
        },
      );
    });
    return this.ready;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async send(msg: WorkerRequestBody, timeoutMs: number): Promise<unknown> {
    if (!this.port) await this.start();
    else await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const port = this.port;
        this.port = null;
        port?.terminate();
        reject(new SandboxTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port!.post({ ...msg, id } as WorkerRequest);
    });
  }

  /** Loads a dataset into a fresh worker (so no state leaks from an earlier file). */
  async load(name: string, bytes: Uint8Array): Promise<DatasetProfile> {
    await this.close();
    this.dataset = { name, bytes };
    return (await this.send({ type: "load", name, bytes }, LOAD_TIMEOUT_MS)) as DatasetProfile;
  }

  /** After a timeout the worker is gone: start over with the same dataset. */
  private async ensureDataset(): Promise<boolean> {
    if (this.port || !this.dataset) return false;
    await this.send({ type: "load", ...this.dataset }, LOAD_TIMEOUT_MS);
    return true;
  }

  async run(code: string): Promise<PythonRun> {
    const restarted = await this.ensureDataset();
    try {
      const run = (await this.send({ type: "run", code }, this.timeoutMs)) as PythonRun;
      return restarted
        ? {
            ...run,
            stdout: `[The sandbox had restarted; earlier variables are gone and df was reloaded.]\n${run.stdout}`,
          }
        : run;
    } catch (err) {
      if (err instanceof SandboxTimeoutError) {
        return {
          stdout: "",
          result: null,
          figures: [],
          error: `${err.message} The sandbox was restarted; earlier variables are gone.`,
        };
      }
      throw err;
    }
  }

  async write(path: string, text: string): Promise<void> {
    await this.ensureDataset();
    await this.send({ type: "write", path, text }, this.timeoutMs);
  }

  async exportCsv(variable: string): Promise<string> {
    await this.ensureDataset();
    return (await this.send({ type: "export", variable }, this.timeoutMs)) as string;
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = null;
    port?.terminate();
    this.failAll(new Error("The Python sandbox was closed."));
  }
}

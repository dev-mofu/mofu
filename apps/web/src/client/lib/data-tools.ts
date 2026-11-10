import {
  ENRICHMENT_SPECS,
  ExportCsvInput,
  PythonSandbox,
  RunPythonInput,
  runResultForModel,
  type WorkerPort,
  type WorkerResponse,
} from "@mofu/core/web";

/** Starts the Pyodide Web Worker. */
function browserPort(): WorkerPort {
  const worker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module" });
  return {
    post: (msg) => worker.postMessage(msg),
    listen(onMessage, onFailure) {
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        // The worker reports a failed boot as id 0 with ok: false.
        if (msg.id === 0 && "ok" in msg && !msg.ok)
          onFailure(new Error(`Python failed to start: ${msg.error}`));
        else onMessage(msg);
      };
      worker.onerror = (e) => onFailure(new Error(e.message || "The Python sandbox crashed."));
    },
    terminate: () => worker.terminate(),
  };
}

export function createBrowserSandbox(onProgress: (m: string) => void): PythonSandbox {
  return new PythonSandbox(browserPort, { onProgress });
}

/** Charts and exported files produced by client tools, kept in the page only. */
export interface Artifacts {
  figures: Map<string, string[]>;
  exports: Map<string, { filename: string; csv: string }>;
}

export const CLIENT_TOOL_NAMES = new Set([
  "run_python",
  "export_csv",
  ...ENRICHMENT_SPECS.map((s) => s.name),
]);

/**
 * Runs one Data Analyst tool in the browser and returns what the model sees.
 * Images and CSV contents stay in `artifacts` (keyed by tool call); the model
 * only gets text.
 */
export async function runClientTool(
  name: string,
  toolCallId: string,
  input: unknown,
  sandbox: PythonSandbox,
  artifacts: Artifacts,
): Promise<unknown> {
  if (name === "run_python") {
    const { code } = RunPythonInput.parse(input);
    const run = await sandbox.run(code);
    const names = run.figures.map((_, i) => `chart ${i + 1}`);
    if (run.figures.length) artifacts.figures.set(toolCallId, run.figures);
    return runResultForModel(run, names);
  }
  if (name === "export_csv") {
    const { variable, filename } = ExportCsvInput.parse(input);
    const csv = await sandbox.exportCsv(variable);
    artifacts.exports.set(toolCallId, { filename, csv });
    return {
      file: filename,
      rows: Math.max(0, csv.trimEnd().split("\n").length - 1),
      note: "The user can download it from the chat.",
    };
  }
  const spec = ENRICHMENT_SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`Unknown tool ${name}`);
  const parsed = spec.inputSchema.parse(input);
  const result = await spec.fetch(parsed as never, {});
  await sandbox.write(result.path, result.csv);
  return { file: result.path, rows: result.rows, summary: result.summary };
}

export function downloadText(filename: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool, type MofuTool } from "../tools/types.js";
import type { NodePythonSandbox } from "./node-sandbox.js";
import {
  ENRICHMENT_SPECS,
  EXPORT_CSV_SPEC,
  ExportCsvInput,
  RUN_PYTHON_SPEC,
  RunPythonInput,
  runResultForModel,
} from "./specs.js";

export interface DataToolOptions {
  sandbox: NodePythonSandbox;
  /** Absolute path of ./mofu-output in the workspace. */
  outputDir: string;
  /** Called with saved chart paths so the CLI can print them. */
  onFiles?: (paths: string[]) => void;
}

/** The Data Analyst tools for `mofu analyze`, bound to one sandbox. */
export function createDataTools(opts: DataToolOptions): MofuTool[] {
  let figureCount = 0;
  const rel = (abs: string) => path.relative(process.cwd(), abs).split(path.sep).join("/");

  const runPython = defineTool({
    name: RUN_PYTHON_SPEC.name,
    description: `${RUN_PYTHON_SPEC.description} Charts are saved to ./mofu-output/.`,
    inputSchema: RunPythonInput,
    kind: "exec",
    surfaces: ["cli"],
    summarize: (input) => `run_python ${input.code.split("\n").find((l) => l.trim()) ?? ""}`,
    async describeApproval(input) {
      return {
        toolName: "run_python",
        kind: "exec",
        title: "Run analysis code in the Python sandbox (no network, no access to your files)",
        detail: input.code,
      };
    },
    async execute(input) {
      const run = await opts.sandbox.run(input.code);
      const saved: string[] = [];
      if (run.figures.length) {
        await mkdir(opts.outputDir, { recursive: true });
        for (const png of run.figures) {
          const file = path.join(opts.outputDir, `figure-${++figureCount}.png`);
          await writeFile(file, Buffer.from(png, "base64"));
          saved.push(rel(file));
        }
        opts.onFiles?.(saved);
      }
      return runResultForModel(run, saved);
    },
  });

  const enrichment = ENRICHMENT_SPECS.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // Fetches public data into the sandbox's memory; touches no user files.
      kind: "read",
      surfaces: ["cli"],
      summarize: (input) => `${spec.name} ${JSON.stringify(input).slice(0, 80)}`,
      async execute(input, ctx) {
        const result = await spec.fetch(input as never, {
          ...(ctx.signal && { signal: ctx.signal }),
        });
        await opts.sandbox.write(result.path, result.csv);
        return { file: result.path, rows: result.rows, summary: result.summary };
      },
    }),
  );

  const exportCsv = defineTool({
    name: EXPORT_CSV_SPEC.name,
    description: `${EXPORT_CSV_SPEC.description} Saved to ./mofu-output/.`,
    inputSchema: ExportCsvInput,
    kind: "write",
    surfaces: ["cli"],
    summarize: (input) => `export_csv ${input.filename}`,
    async describeApproval(input) {
      return {
        toolName: "export_csv",
        kind: "write",
        title: `Save ${rel(path.join(opts.outputDir, input.filename))}`,
        detail: `The DataFrame \`${input.variable}\` as CSV.`,
      };
    },
    async execute(input) {
      const csv = await opts.sandbox.exportCsv(input.variable);
      await mkdir(opts.outputDir, { recursive: true });
      const file = path.join(opts.outputDir, input.filename);
      await writeFile(file, csv, "utf8");
      opts.onFiles?.([rel(file)]);
      return { file: rel(file), rows: Math.max(0, csv.trimEnd().split("\n").length - 1) };
    },
  });

  return [runPython, ...enrichment, exportCsv] as MofuTool[];
}

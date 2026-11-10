import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  createDataTools,
  DATA_SECTION,
  formatProfileForModel,
  NodePythonSandbox,
  suggestQuestions,
  type MofuTool,
} from "@mofu/core";
import { mofuHome } from "./config.js";
import type { Printer } from "./ui.js";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const SUPPORTED = /\.(csv|tsv|txt|json|xlsx|xlsm)$/i;

export interface Analysis {
  sandbox: NodePythonSandbox;
  tools: MofuTool[];
  modeSection: string;
}

/** Loads the file into a fresh Python sandbox and prints its profile. */
export async function startAnalysis(file: string, printer: Printer): Promise<Analysis | null> {
  const abs = path.resolve(file);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) {
    printer.error(`No such file: ${file}`);
    return null;
  }
  if (!SUPPORTED.test(abs)) {
    printer.error("mofu analyze reads CSV, TSV, JSON and Excel (.xlsx) files.");
    return null;
  }
  if (info.size > MAX_FILE_BYTES) {
    printer.error(
      `That file is ${Math.round(info.size / 1e6)} MB; the limit is ${MAX_FILE_BYTES / 1e6} MB.`,
    );
    return null;
  }
  const name = path.basename(abs);
  const sandbox = new NodePythonSandbox({
    cacheDir: path.join(mofuHome(), "pyodide-cache"),
    onProgress: (m) => printer.line(pc.dim(m)),
  });
  let profile;
  try {
    profile = await sandbox.load(name, new Uint8Array(await readFile(abs)));
  } catch (err) {
    await sandbox.close();
    printer.error(`Couldn't read ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  printer.line();
  printer.line(
    pc.bold(
      `${name}: ${profile.rows.toLocaleString("en-US")} rows × ${profile.columns.length} columns`,
    ),
  );
  printer.line(pc.dim(profile.columns.map((c) => `${c.name} (${c.kind})`).join(", ")));
  for (const p of profile.problems) printer.line(pc.yellow(`· ${p}`));
  printer.line();
  printer.line(pc.dim("Try:"));
  for (const q of suggestQuestions(profile)) printer.line(pc.dim(`  ${q}`));

  const tools = createDataTools({
    sandbox,
    outputDir: path.join(process.cwd(), "mofu-output"),
    onFiles: (paths) => paths.forEach((p) => printer.line(pc.green(`  saved ${p}`))),
  });
  const modeSection = `${DATA_SECTION}\n\n<dataset_profile>\n${formatProfileForModel(name, profile)}\n</dataset_profile>`;
  return { sandbox, tools, modeSection };
}

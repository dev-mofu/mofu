import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  formatScanForModel,
  MANIFEST_PATTERN,
  scanDependencies,
  type ScanReport,
} from "../deps/index.js";
import { defineTool } from "./types.js";
import { requireWorkspace } from "./workspace.js";
import { walkFiles } from "./walk.js";

const MAX_MANIFESTS = 20;

/** Reads every supported manifest/lockfile in the workspace (skipping node_modules etc.). */
export async function readLocalManifests(
  root: string,
): Promise<Array<{ path: string; text: string }>> {
  const paths = (await walkFiles(root))
    .filter((p) => MANIFEST_PATTERN.test(p))
    .slice(0, MAX_MANIFESTS);
  return Promise.all(
    paths.map(async (p) => ({ path: p, text: await readFile(path.join(root, p), "utf8") })),
  );
}

export async function scanWorkspace(
  root: string,
  opts: { onProgress?: (m: string) => void; signal?: AbortSignal } = {},
): Promise<ScanReport> {
  const files = await readLocalManifests(root);
  if (files.length === 0) {
    throw new Error(
      "No package.json, package-lock.json, requirements*.txt or pyproject.toml found here.",
    );
  }
  return scanDependencies(files, opts);
}

export const scanDependenciesTool = defineTool({
  name: "scan_dependencies",
  description:
    "Scan the project's dependencies (npm package.json/package-lock.json, Python requirements*.txt/pyproject.toml) " +
    "for known vulnerabilities (OSV), outdated versions, deprecated and unmaintained packages. Returns a compact " +
    "report with fix versions. Only cite IDs and versions from this report.",
  inputSchema: z.object({}),
  kind: "read",
  surfaces: ["cli"],
  summarize: () => "scan_dependencies",
  async execute(_input, ctx) {
    const report = await scanWorkspace(requireWorkspace(ctx), {
      ...(ctx.signal && { signal: ctx.signal }),
    });
    return { report: formatScanForModel(report) };
  },
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";

/** Never worth listing or searching. */
export const ALWAYS_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/__pycache__/**",
];

async function loadGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  try {
    ig.add(await readFile(path.join(root, ".gitignore"), "utf8"));
  } catch {
    // No .gitignore is fine.
  }
  return ig;
}

/**
 * Lists files under `root` matching `pattern`, relative with forward slashes,
 * honoring the root .gitignore and skipping dependency/build folders.
 */
export async function walkFiles(root: string, pattern = "**/*"): Promise<string[]> {
  const ig = await loadGitignore(root);
  const entries = await fg(pattern, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ALWAYS_IGNORED,
    suppressErrors: true,
  });
  return entries.filter((e) => !ig.ignores(e)).sort();
}

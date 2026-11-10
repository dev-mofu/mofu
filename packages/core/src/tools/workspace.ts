import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "./types.js";

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves the real path of `p`, or of its nearest existing ancestor plus the missing tail. */
async function realpathAllowingMissing(p: string): Promise<string> {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a user/model-supplied path against the workspace root and refuses
 * anything that ends up outside it, including through `..`, absolute paths,
 * symlinks or junctions.
 */
export async function resolveInWorkspace(root: string, p: string): Promise<string> {
  if (p.includes("\0")) throw new WorkspaceError("Invalid path.");
  const rootReal = await realpath(root);
  const requested = path.resolve(rootReal, p);
  // Check the lexical path first so `..` escapes fail even if the target doesn't exist.
  if (!isInside(rootReal, requested)) {
    throw new WorkspaceError(`Path is outside the workspace: ${p}`);
  }
  const real = await realpathAllowingMissing(requested);
  if (!isInside(rootReal, real)) {
    throw new WorkspaceError(`Path resolves outside the workspace (symlink?): ${p}`);
  }
  return real;
}

export function requireWorkspace(ctx: ToolContext): string {
  if (!ctx.workspaceRoot) throw new WorkspaceError("This tool needs a workspace directory.");
  return ctx.workspaceRoot;
}

/** Path relative to the root with forward slashes, for showing to the model and user. */
export function displayPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

export const MAX_FILE_BYTES = 1_000_000;

/** Reads a text file, refusing binaries and files over the size cap. */
export async function readTextFile(abs: string): Promise<string> {
  const info = await stat(abs);
  if (info.isDirectory()) throw new WorkspaceError("That path is a directory, not a file.");
  if (info.size > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      `File is too large (${info.size} bytes, limit ${MAX_FILE_BYTES}). Use search_files or a line range.`,
    );
  }
  const buf = await readFile(abs);
  if (looksBinary(buf)) throw new WorkspaceError("File looks binary; refusing to read it as text.");
  return buf.toString("utf8");
}

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

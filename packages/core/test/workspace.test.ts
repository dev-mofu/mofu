import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInWorkspace, WorkspaceError } from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("resolveInWorkspace", () => {
  it("resolves paths inside the workspace, including files that don't exist yet", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "a.txt"), "hi");
    expect(await resolveInWorkspace(root, "a.txt")).toMatch(/a\.txt$/);
    expect(await resolveInWorkspace(root, "new/dir/b.txt")).toMatch(/b\.txt$/);
    expect(await resolveInWorkspace(root, "./sub/../a.txt")).toMatch(/a\.txt$/);
  });

  it("rejects .. escapes", async () => {
    const root = await tempDir();
    await expect(resolveInWorkspace(root, "../outside.txt")).rejects.toBeInstanceOf(WorkspaceError);
    await expect(resolveInWorkspace(root, "sub/../../x")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("rejects absolute paths outside the workspace but allows ones inside", async () => {
    const root = await tempDir();
    const other = await tempDir();
    await expect(resolveInWorkspace(root, path.join(other, "x.txt"))).rejects.toBeInstanceOf(
      WorkspaceError,
    );
    expect(await resolveInWorkspace(root, path.join(root, "inside.txt"))).toMatch(/inside\.txt$/);
  });

  it("rejects symlinks/junctions that point outside", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "secret");
    // "junction" works on Windows without admin rights; ignored elsewhere.
    await symlink(outside, path.join(root, "link"), "junction");
    await expect(resolveInWorkspace(root, "link/secret.txt")).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(resolveInWorkspace(root, "link/new-file.txt")).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("allows symlinks that stay inside", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "f.txt"), "ok");
    await symlink(path.join(root, "real"), path.join(root, "alias"), "junction");
    expect(await resolveInWorkspace(root, "alias/f.txt")).toMatch(/f\.txt$/);
  });

  it("rejects null bytes", async () => {
    const root = await tempDir();
    await expect(resolveInWorkspace(root, "a\0b")).rejects.toBeInstanceOf(WorkspaceError);
  });
});

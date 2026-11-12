import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { auditSolidity, AUDIT_LIMITS, type FileAudit } from "./solidity.js";

export { auditSolidity, blankCommentsAndStrings, AUDIT_LIMITS } from "./solidity.js";
export type { AuditCheck, AuditIssue, AuditStatus, FileAudit } from "./solidity.js";

export interface AuditReport {
  target: string;
  files: FileAudit[];
  limits: string[];
}

const SKIP = /(^|[\\/])(node_modules|lib|out|cache|artifacts|typechain-types|\.git)([\\/]|$)/;

async function solFiles(target: string): Promise<string[]> {
  const st = await stat(target);
  if (st.isFile()) return target.endsWith(".sol") ? [target] : [];
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (SKIP.test(path.relative(target, p))) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".sol") && !/\.t\.sol$|\.s\.sol$/.test(e.name))
        out.push(p);
      if (out.length >= 200) return;
    }
  };
  await walk(target);
  return out.sort();
}

/** Audits one .sol file or every .sol file under a folder (tests, scripts and libraries skipped). */
export async function auditPath(target: string, root = process.cwd()): Promise<AuditReport> {
  const abs = path.resolve(root, target);
  const files = await solFiles(abs);
  const audits: FileAudit[] = [];
  for (const f of files) {
    const source = await readFile(f, "utf8");
    audits.push(
      auditSolidity(path.relative(root, f).replace(/\\/g, "/") || path.basename(f), source),
    );
  }
  return { target, files: audits, limits: [...AUDIT_LIMITS] };
}

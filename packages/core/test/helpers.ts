import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { ApprovalRequest, ToolContext } from "../src/index.js";

const created: string[] = [];

/** A fresh temp directory, removed after each test. */
export async function tempDir(prefix = "mofu-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Context whose approve() returns `answer` and records every request. */
export function testContext(
  workspaceRoot: string | undefined,
  answer = true,
): ToolContext & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    ...(workspaceRoot && { workspaceRoot }),
    requests,
    approve: async (req) => {
      requests.push(req);
      return answer;
    },
  };
}

/** A fetch stub that returns a fixed JSON body and status. */
export function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

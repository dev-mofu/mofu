import { modelTarget } from "./target.js";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  API_TOOL_SPECS,
  APIFORGE_SECTION,
  ApiWorkspace,
  buildSystemPrompt,
  classifyTarget,
  createModel,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  defineTool,
  diffSpecs,
  fetchPublicDocument,
  formatDiffForModel,
  formatDiffMarkdown,
  formatIndexForModel,
  formatRunForModel,
  formatRunMarkdown,
  loadSpec,
  parseAuthHeader,
  parseSuiteJson,
  runSuite,
  runTurn,
  toHttpFile,
  toSuiteJson,
  toVitestFile,
  type ApiIndex,
  type MofuError,
  type MofuTool,
  type SpecDiff,
  type TestCase,
} from "@mofu/core";
import type { ApiArgs } from "./args.js";
import type { ChatSession } from "./session.js";
import type { Terminal } from "./terminal.js";
import type { Printer } from "./ui.js";

const OUTPUT_DIR = "mofu-output";
const nodeResolver = async (host: string) =>
  (await lookup(host, { all: true })).map((a) => a.address);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "api";

async function readSpec(target: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) {
    try {
      return (await fetchPublicDocument(target, nodeResolver)).text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The link guard refuses local addresses; a local dev server's spec can be saved first.
      throw new Error(
        /isn't public/.test(message)
          ? `${message} For a local server, save the spec first: curl -o openapi.json ${target}`
          : message,
        { cause: err },
      );
    }
  }
  return readFile(path.resolve(target), "utf8");
}

/** Loads and validates a spec, printing problems. Returns null after printing why. */
export async function loadSpecFrom(target: string, printer: Printer): Promise<ApiIndex | null> {
  let text: string;
  try {
    text = await readSpec(target);
  } catch (err) {
    printer.error(
      err instanceof Error && "code" in err && err.code === "ENOENT"
        ? `No such file: ${target}`
        : (err as Error).message,
    );
    return null;
  }
  const loaded = await loadSpec(text);
  if (!loaded.ok) {
    printer.error(`${target} isn't a valid OpenAPI/Swagger spec:`);
    for (const p of loaded.problems.slice(0, 15))
      printer.line(pc.red(`  ${p.path || "(document)"}: ${p.message}`));
    if (loaded.problems.length > 15)
      printer.line(pc.red(`  … and ${loaded.problems.length - 15} more`));
    return null;
  }
  for (const w of loaded.warnings) printer.line(pc.yellow(`  ${w.path}: ${w.message}`));
  return loaded.index;
}

function printIndex(index: ApiIndex, printer: Printer): void {
  const groups = new Set(index.endpoints.map((e) => e.tags[0]));
  printer.line();
  printer.line(
    pc.bold(`${index.title} ${index.version}`) +
      pc.dim(
        ` · ${index.specVersion.startsWith("2") ? "Swagger" : "OpenAPI"} ${index.specVersion} · ${index.endpoints.length} endpoints in ${groups.size} groups`,
      ),
  );
  for (const e of index.endpoints) {
    printer.line(
      `  ${pc.cyan(e.method.toUpperCase().padEnd(6))} ${e.path.padEnd(28)} ${pc.dim(`${e.responses.map((r) => r.status).join(" ")}${e.security.length ? " · auth" : ""}${e.summary ? ` · ${e.summary}` : ""}`)}`,
    );
  }
}

function printDiff(diff: SpecDiff, printer: Printer): void {
  printer.line();
  printer.line(
    pc.bold(`${diff.from.title} ${diff.from.version} → ${diff.to.version}: `) +
      pc.red(`${diff.breaking.length} breaking`) +
      pc.dim(`, ${diff.nonBreaking.length} non-breaking`),
  );
  for (const c of diff.breaking)
    printer.line(`  ${pc.red("✗")} ${c.endpoint} ${pc.dim("·")} ${c.location}: ${c.message}`);
  for (const c of diff.nonBreaking)
    printer.line(pc.dim(`  ✓ ${c.endpoint} · ${c.location}: ${c.message}`));
}

async function save(name: string, text: string, printer: Printer): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, name);
  await writeFile(file, text);
  printer.line(pc.green(`  saved ${file.split(path.sep).join("/")}`));
  return file;
}

export interface ApiPlan {
  modeSection: string;
  tools: MofuTool[];
  maxSteps: number;
  /** Runs the command. Returns an exit code, or "chat" to continue as an interactive session. */
  run(ctx: {
    session: ChatSession;
    terminal: Terminal;
    apiKey: string;
    model: string;
  }): Promise<number | "chat">;
}

function workspaceTools(ws: ApiWorkspace): MofuTool[] {
  return API_TOOL_SPECS.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      kind: "read",
      surfaces: ["cli"],
      summarize: (input) => `${spec.name} ${String((input as { group?: unknown }).group ?? "")}`,
      execute: async (input) => ws.run(spec.name, input),
    }),
  );
}

/** Asks the model to cover every group, with one follow-up for groups it skipped. */
async function generate(
  kind: "tests" | "docs",
  ws: ApiWorkspace,
  session: ChatSession,
  printer: Printer,
): Promise<boolean> {
  const tool = kind === "tests" ? "create_test_cases" : "write_endpoint_docs";
  const covered = () =>
    new Set(
      kind === "tests"
        ? ws.cases.map(
            (c) => ws.index.endpoints.find((e) => e.key === `${c.method} ${c.endpoint}`)?.tags[0],
          )
        : [...ws.descriptions.keys()].map(
            (k) => ws.index.endpoints.find((e) => e.key === k)?.tags[0],
          ),
    );
  const ask = (groups: string[]) =>
    kind === "tests"
      ? `Generate test cases for these endpoint groups, one group at a time with get_endpoint_group then ${tool}: ${groups.join(", ")}.`
      : `Write endpoint descriptions for these groups, one group at a time with get_endpoint_group then ${tool}: ${groups.join(", ")}.`;
  if (!(await session.send(ask(ws.groups)))) return false;
  const missing = ws.groups.filter((g) => !covered().has(g));
  if (missing.length) {
    printer.line(pc.dim(`  Asking Mofu to finish: ${missing.join(", ")}`));
    if (!(await session.send(`Continue: ${ask(missing)}`))) return false;
  }
  const stillMissing = ws.groups.filter((g) => !covered().has(g));
  if (stillMissing.length) printer.line(pc.yellow(`  Not covered: ${stillMissing.join(", ")}`));
  return true;
}

async function saveSuite(ws: ApiWorkspace, printer: Printer): Promise<void> {
  const name = slug(ws.index.title);
  const suite = ws.suite();
  const base = ws.index.servers[0] ?? "http://localhost:3000";
  const byCategory = new Map<string, number>();
  for (const c of suite.cases) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
  printer.line();
  printer.line(
    pc.bold(`${suite.cases.length} test cases`) +
      pc.dim(` (${[...byCategory].map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")})`),
  );
  await save(`${name}.tests.json`, toSuiteJson(suite), printer);
  await save(`${name}.test.ts`, toVitestFile(suite, base), printer);
  await save(`${name}.http`, toHttpFile(suite, base), printer);
}

export async function prepareApi(args: ApiArgs, printer: Printer): Promise<ApiPlan | null> {
  const index = await loadSpecFrom(args.spec, printer);
  if (!index) return null;

  if (args.sub === "diff") {
    const next = await loadSpecFrom(args.spec2!, printer);
    if (!next) return null;
    const diff = diffSpecs(index, next);
    printDiff(diff, printer);
    return {
      modeSection: APIFORGE_SECTION,
      tools: [],
      maxSteps: 1,
      async run({ apiKey, model }) {
        await save("api-diff.md", formatDiffMarkdown(diff), printer);
        await save("api-diff.json", `${JSON.stringify(diff, null, 2)}\n`, printer);
        if (!diff.breaking.length && !diff.nonBreaking.length) return 0;
        printer.line();
        try {
          const result = await runTurn({
            model: createModel({ apiKey, modelId: model, ...modelTarget() }),
            instructions: buildSystemPrompt({ surface: "cli", modeSection: APIFORGE_SECTION }),
            messages: [
              {
                role: "user",
                content: `${formatDiffForModel(diff)}\n\nExplain the impact of the breaking changes for API consumers and write a short migration note. Stay under 300 words.`,
              },
            ],
            tools: {},
            limits: { maxSteps: 1, maxOutputTokens: 2_000 },
            onEvent: (e) => e.type === "text-delta" && printer.write(e.text),
          });
          printer.newline();
          printer.usage(result.usage, model);
          return 0;
        } catch (err) {
          printer.error((err as MofuError).message);
          return 1;
        }
      },
    };
  }

  printIndex(index, printer);
  const ws = new ApiWorkspace(index);
  const plan = {
    modeSection: `${APIFORGE_SECTION}\n\n<api_endpoints>\n${formatIndexForModel(index)}\n</api_endpoints>`,
    tools: workspaceTools(ws),
    // Two steps per group (fetch, then generate) plus retries and the final reply.
    maxSteps: Math.min(40, ws.groups.length * 3 + 4),
  };

  if (args.sub === "docs") {
    return {
      ...plan,
      async run({ session }) {
        if (!(await generate("docs", ws, session, printer)) && !ws.descriptions.size) return 1;
        printer.line();
        await save(`${slug(index.title)}-docs.md`, ws.docs(), printer);
        return 0;
      },
    };
  }

  if (args.sub === "tests") {
    return {
      ...plan,
      async run({ session }) {
        if (!(await generate("tests", ws, session, printer)) && !ws.cases.length) return 1;
        if (!ws.cases.length) {
          printer.error("No valid test cases were generated.");
          return 1;
        }
        await saveSuite(ws, printer);
        return 0;
      },
    };
  }

  // mofu api test: run a suite against a live server.
  return {
    ...plan,
    async run({ session, terminal }) {
      let auth: { name: string; value: string } | undefined;
      try {
        auth = parseAuthHeader(args.authHeader ?? process.env.MOFU_API_AUTH);
      } catch (err) {
        printer.error((err as Error).message);
        return 1;
      }
      let cases: TestCase[];
      const suiteFile = args.suite ?? path.join(OUTPUT_DIR, `${slug(index.title)}.tests.json`);
      if (existsSync(suiteFile)) {
        try {
          cases = parseSuiteJson(await readFile(suiteFile, "utf8"));
        } catch (err) {
          printer.error(`Couldn't read ${suiteFile}: ${(err as Error).message}`);
          return 1;
        }
        printer.line(
          pc.dim(`Using ${cases.length} test cases from ${suiteFile.split(path.sep).join("/")}`),
        );
      } else if (args.suite) {
        printer.error(`No such file: ${args.suite}`);
        return 1;
      } else {
        printer.line(pc.dim("No saved test suite yet, so Mofu will generate one first."));
        await generate("tests", ws, session, printer);
        if (!ws.cases.length) {
          printer.error("No valid test cases were generated.");
          return 1;
        }
        await saveSuite(ws, printer);
        cases = ws.cases;
      }

      const baseUrl = args.baseUrl!;
      const target = await classifyTarget(baseUrl, nodeResolver);
      const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      printer.line();
      printer.line(
        pc.bold(`About to send ${cases.length} requests to ${target.host}`) +
          pc.dim(` (${baseUrl}, ${concurrency} at a time, ${timeoutMs} ms timeout)`),
      );
      if (!target.local) {
        printer.line(
          pc.yellow(
            `  ⚠ ${target.host} isn't localhost or a private address. These requests hit a real server and may create, change or delete data.`,
          ),
        );
      }
      if (auth) printer.line(pc.dim(`  Auth header: ${auth.name} (value hidden)`));
      if (!args.yes && !(await terminal.confirm(`Run the tests? (y/n) `))) {
        printer.line(pc.dim("Cancelled. Nothing was sent."));
        return 1;
      }

      const report = await runSuite(cases, {
        baseUrl,
        index,
        concurrency,
        timeoutMs,
        ...(auth && { authHeader: auth }),
        onResult: (r) =>
          printer.line(
            r.passed
              ? `  ${pc.green("✓")} ${r.id} ${pc.dim(`${r.method} ${r.endpoint} · ${r.status} · ${r.latencyMs} ms`)}`
              : `  ${pc.red("✗")} ${r.id} ${pc.dim(`${r.method} ${r.endpoint} · ${r.latencyMs} ms`)}\n      ${pc.red(r.failures.join("; "))}`,
          ),
      });
      printer.line();
      printer.line(
        pc.bold(`${report.passed}/${report.total} passed`) +
          (report.failed ? pc.red(` · ${report.failed} failed`) : "") +
          pc.dim(
            ` · p50 ${report.latency.p50} ms · p95 ${report.latency.p95} ms · max ${report.latency.max} ms`,
          ),
      );
      const stamp = report.startedAt.replace(/[:.]/g, "-").slice(0, 19);
      await save(`test-run-${stamp}.json`, `${JSON.stringify(report, null, 2)}\n`, printer);
      await save(
        `test-run-${stamp}.md`,
        formatRunMarkdown(report, `${index.title} ${index.version}`),
        printer,
      );
      if (!report.failed) return 0;
      printer.line();
      await session.send(
        `${formatRunForModel(report)}\n\nSummarize these failures and suggest likely causes. If this API's code is in the current folder, offer to look at the relevant handlers.`,
      );
      // --yes is for scripts and CI: no chat afterwards, and failures set the exit code.
      return args.yes ? 1 : "chat";
    },
  };
}

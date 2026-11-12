/**
 * Mofu's remote MCP server at /mcp (Streamable HTTP, stateless, JSON responses).
 *
 * Any MCP client (Claude Desktop, Claude Code, Cursor, …) can call Mofu's deterministic tools:
 * the Token Scanner and the dependency check. Neither calls a model, so the client's own AI does
 * the explaining and Mofu only pays for chain and OSV lookups. Calls are limited per IP per day.
 */
import { Hono } from "hono";
import { z } from "zod";
import { formatScanForModel, scanDependencies } from "@mofu/core/web";
import {
  formatTokenScanForModel,
  formatTxForModel,
  formatWalletForModel,
} from "../shared/token-scan-text.js";
import { walletReport } from "./wallet.js";
import { explainTransaction, type ChainDataOptions } from "./chain-data.js";
import type { AppDeps } from "./app.js";
import { statsFromEnv, tokenIndexFromEnv, type StatKey } from "./stats.js";
import { withLookalikes } from "./lookalike.js";
import { parseRpcUrls } from "./chain.js";
import { isAddress } from "./holder.js";
import { scanToken, summaryOnly } from "./token-scan.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

/** Manifest names the dependency check understands. */
const MANIFESTS = ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml"];
const MAX_FILES = 6;
const MAX_TOTAL_CHARS = 600_000;

const INSTRUCTIONS =
  "Mofu's tools read real data and return facts: scan_token reads a token contract on Robinhood Chain, " +
  "explain_transaction decodes a Robinhood Chain transaction, " +
  "check_wallet lists a wallet's token approvals (re-checked on chain, risky ones flagged) and holdings, " +
  "check_dependencies looks up known vulnerabilities for a project's packages. Report what the results " +
  "say and what they can't see. For tokens, never give buy, sell or price advice and never call a token " +
  "safe: describe what the contract's code allows.";

const TOOLS = [
  {
    name: "check_wallet",
    title: "Check a wallet's approvals on Robinhood Chain",
    description:
      "Wallet Health for an address on Robinhood Chain (chain ID 4663): every active token approval, " +
      "re-checked on chain, with the spender described (known contract, launch curve, pool, or a plain wallet) " +
      "and risky ones flagged (spender is a wallet, a brand-new little-used contract, or the allowance is " +
      "unlimited); plus the tokens it holds. To remove an approval the owner sends approve(spender, 0) from " +
      "their own wallet, or uses mofu.works/app. Deterministic, not AI.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Wallet address: 0x followed by 40 hex characters.",
          pattern: "^0x[0-9a-fA-F]{40}$",
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: {
      title: "Check a wallet's approvals on Robinhood Chain",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "scan_token",
    title: "Scan a Robinhood Chain token",
    description:
      "Scan a token contract on Robinhood Chain (chain ID 4663) and report what its code allows: minting " +
      "new tokens, pausing transfers, blocking wallets, changing fees or trading limits, upgradeable code, " +
      "who the owner is, total supply and burned share. Reads the chain directly; deterministic, not AI. " +
      "A technical check of the contract only: it doesn't cover price, liquidity or holder distribution, " +
      "and it isn't financial advice.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "Token contract address on Robinhood Chain: 0x followed by 40 hex characters.",
          pattern: "^0x[0-9a-fA-F]{40}$",
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: {
      title: "Scan a Robinhood Chain token",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "check_dependencies",
    title: "Check dependencies for vulnerabilities",
    description:
      "Check a project's dependencies for known vulnerabilities (OSV) and outdated or deprecated packages " +
      "(deps.dev). Pass the contents of package.json, package-lock.json, requirements.txt or pyproject.toml. " +
      "With a lockfile, exact installed versions are checked, including transitive ones. Returns findings " +
      "with severity, the version that fixes them and how far behind each package is. Deterministic, not AI.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FILES,
          description: "Manifest files from the project.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: `File path; the name must be one of: ${MANIFESTS.join(", ")}.`,
              },
              content: { type: "string", description: "Full text of the file." },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: {
      title: "Check dependencies for vulnerabilities",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "explain_transaction",
    title: "Explain a Robinhood Chain transaction",
    description:
      "Decode a transaction on Robinhood Chain (chain ID 4663): status, sender and target, ETH value and fee, " +
      "every token transfer (mints and burns marked), approvals (who may now move which tokens, unlimited " +
      "ones flagged, spenders that are plain wallets flagged) and other events. Deterministic, not AI.",
    inputSchema: {
      type: "object",
      properties: {
        hash: {
          type: "string",
          description: "Transaction hash: 0x followed by 64 hex characters.",
          pattern: "^0x[0-9a-fA-F]{64}$",
        },
      },
      required: ["hash"],
      additionalProperties: false,
    },
    annotations: {
      title: "Explain a Robinhood Chain transaction",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;

const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type Message = z.infer<typeof Message>;

const ScanArgs = z.object({ address: z.string() });
const DepsArgs = z.object({
  files: z
    .array(z.object({ path: z.string().max(300), content: z.string() }))
    .min(1)
    .max(MAX_FILES),
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const toolText = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError: true }),
});

const rpcError = (id: Message["id"] | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const mcpDailyLimit = (env: Env) =>
  Math.max(0, Number.parseInt(String(env.MCP_DAILY_LIMIT), 10) || 0);

export function createMcpApp(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();
  const chainData = (env: Env, urls: readonly string[]): ChainDataOptions | undefined => {
    const apiKey = (env as Env & { GOLDRUSH_API_KEY?: string }).GOLDRUSH_API_KEY;
    return apiKey
      ? {
          apiKey,
          chain: String(env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
          rpcUrls: urls,
          fetch: deps.fetch,
        }
      : undefined;
  };

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(CORS)) c.header(k, v);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.options("/mcp", (c) => c.body(null, 204));
  // Stateless server: no server-initiated stream and no sessions to end.
  app.get("/mcp", (c) => {
    // People opening the link in a browser get the setup guide; MCP clients get a plain 405.
    const accept = c.req.header("Accept") ?? "";
    if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
      return c.redirect("/docs/#mcp", 302);
    }
    c.header("Allow", "POST");
    return c.text("This MCP endpoint takes POST requests (Streamable HTTP).", 405);
  });
  app.delete("/mcp", (c) => {
    c.header("Allow", "POST");
    return c.body(null, 405);
  });

  async function callTool(
    c: { env: Env; ip: string; record: (key: StatKey) => void },
    name: string,
    args: unknown,
  ): Promise<ToolResult> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return toolText(`Unknown tool: ${name}.`, true);

    const limit = mcpDailyLimit(c.env);
    const usage = await deps.getLimiter(c.env).check(c.ip, limit, true, "mcp");
    if (!usage.allowed) {
      return toolText(
        `Mofu's daily limit of ${limit} tool calls from this network is used up. It resets at ${usage.resetAt}.`,
        true,
      );
    }

    if (name === "scan_token") {
      const parsed = ScanArgs.safeParse(args);
      if (!parsed.success || !isAddress(parsed.data.address)) {
        return toolText(
          "address must be a contract address: 0x followed by 40 hex characters.",
          true,
        );
      }
      const urls = parseRpcUrls(c.env.HOLDER_RPC_URL);
      try {
        const data = chainData(c.env, urls);
        // MCP has no wallet login, so it gets the holder summary, not the full holder report.
        let index = null;
        try {
          index = (deps.getTokenIndex ?? tokenIndexFromEnv)(c.env);
        } catch {
          // no index binding
        }
        const report = summaryOnly(
          await withLookalikes(
            await scanToken(
              urls,
              parsed.data.address,
              deps.fetch,
              data && { ...data, now: deps.now() },
            ),
            index,
            data,
          ),
        );
        c.record("mcp_scan_token");
        return {
          content: [
            {
              type: "text",
              text: `${formatTokenScanForModel(report)}\n\nShareable report: https://mofu.works/token/${report.address}`,
            },
          ],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch {
        return toolText("Couldn't reach Robinhood Chain right now. Try again in a minute.", true);
      }
    }

    if (name === "check_wallet") {
      const address = String((args as { address?: unknown } | null)?.address ?? "").trim();
      if (!isAddress(address)) {
        return toolText(
          "address must be a wallet address: 0x followed by 40 hex characters.",
          true,
        );
      }
      const data = chainData(c.env, parseRpcUrls(c.env.HOLDER_RPC_URL));
      if (!data) return toolText("Wallet checks aren't available right now.", true);
      const report = await walletReport({ ...data, now: deps.now() }, address);
      if (report.status.approvals === "unavailable" && report.status.holdings === "unavailable") {
        return toolText("That wallet couldn't be read right now. Try again in a minute.", true);
      }
      c.record("mcp_check_wallet");
      return {
        content: [
          {
            type: "text",
            text: `${formatWalletForModel(report)}\n\nCheck and revoke in the browser: https://mofu.works/app/?scan=${report.address}`,
          },
        ],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    }

    if (name === "explain_transaction") {
      const hash = String((args as { hash?: unknown } | null)?.hash ?? "")
        .trim()
        .toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) {
        return toolText("hash must be a transaction hash: 0x followed by 64 hex characters.", true);
      }
      const data = chainData(c.env, parseRpcUrls(c.env.HOLDER_RPC_URL));
      if (!data) return toolText("The transaction explainer isn't available right now.", true);
      try {
        const report = await explainTransaction(data, hash);
        c.record("mcp_explain_transaction");
        return {
          content: [{ type: "text", text: formatTxForModel(report) }],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch {
        return toolText(
          "That transaction couldn't be read. Check the hash, or try again in a minute.",
          true,
        );
      }
    }

    const parsed = DepsArgs.safeParse(args);
    if (!parsed.success) {
      return toolText(`files must be 1–${MAX_FILES} objects with a path and content.`, true);
    }
    const files = parsed.data.files;
    const unknown = files.filter((f) => !MANIFESTS.includes(f.path.split(/[\\/]/).pop() ?? ""));
    if (unknown.length) {
      return toolText(
        `Unsupported file: ${unknown.map((f) => f.path).join(", ")}. Use ${MANIFESTS.join(", ")}.`,
        true,
      );
    }
    if (files.reduce((n, f) => n + f.content.length, 0) > MAX_TOTAL_CHARS) {
      return toolText("Those files are too large together (600,000 characters at most).", true);
    }
    try {
      const report = await scanDependencies(
        files.map((f) => ({ path: f.path, text: f.content })),
        { fetch: deps.fetch, signal: AbortSignal.timeout(60_000) },
      );
      c.record("mcp_check_dependencies");
      return toolText(formatScanForModel(report));
    } catch {
      return toolText("The dependency check couldn't finish. Try again in a minute.", true);
    }
  }

  async function handle(
    msg: Message,
    ctx: { env: Env; ip: string; record: (key: StatKey) => void },
  ) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          jsonrpc: "2.0" as const,
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : DEFAULT_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "mofu",
              title: "Mofu",
              version: SERVER_VERSION,
              websiteUrl: "https://mofu.works",
            },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0" as const, id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0" as const, id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        return {
          jsonrpc: "2.0" as const,
          id,
          result: await callTool(ctx, name, params?.arguments ?? {}),
        };
      }
      case "resources/list":
        return { jsonrpc: "2.0" as const, id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0" as const, id, result: { prompts: [] } };
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  app.post("/mcp", async (c) => {
    const raw = await c.req.text();
    if (raw.length > MAX_TOTAL_CHARS + 50_000) {
      return c.json(rpcError(null, -32600, "Request too large."), 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, -32700, "Parse error."), 400);
    }
    const batch = Array.isArray(body);
    const items: unknown[] = Array.isArray(body) ? body : [body];
    if (items.length === 0 || items.length > 20) {
      return c.json(rpcError(null, -32600, "Invalid request."), 400);
    }
    const ctx = {
      env: c.env,
      ip: c.req.header("CF-Connecting-IP") ?? "local",
      record: (key: StatKey) => {
        try {
          const done = (deps.getStats ?? statsFromEnv)(c.env)
            .add(key)
            .catch(() => undefined);
          try {
            c.executionCtx.waitUntil(done);
          } catch {
            // no execution context in tests
          }
        } catch {
          // no STATS binding
        }
      },
    };
    const responses = [];
    for (const item of items) {
      const parsed = Message.safeParse(item);
      if (!parsed.success) {
        // Responses from the client (to server requests) and malformed messages.
        const maybeId = (item as { id?: unknown } | null)?.id;
        if (typeof maybeId === "string" || typeof maybeId === "number") {
          const isResponse =
            item && typeof item === "object" && ("result" in item || "error" in item);
          if (!isResponse) responses.push(rpcError(maybeId, -32600, "Invalid request."));
        }
        continue;
      }
      // Notifications (no id) get no response.
      if (parsed.data.id === undefined) continue;
      try {
        responses.push(await handle(parsed.data, ctx));
      } catch {
        responses.push(rpcError(parsed.data.id, -32603, "Internal error."));
      }
    }
    if (responses.length === 0) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });

  return app;
}

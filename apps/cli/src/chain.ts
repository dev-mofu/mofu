/**
 * Robinhood Chain safety checks from the terminal: `mofu scan`, `mofu wallet` and `mofu webhook`.
 * They call Mofu's public API (mofu.works/api/v1); no OpenRouter key and no model involved.
 */
import pc from "picocolors";
import type { ChainArgs, WebhookArgs } from "./args.js";
import type { Printer } from "./ui.js";

type Status = "ok" | "warn" | "risk" | "info";

interface TokenReport {
  address: string;
  isContract: boolean;
  token: { name: string | null; symbol: string | null; totalSupply: string | null };
  owner: { status: "none" | "renounced" | "active"; address: string | null };
  checks: Array<{ id: string; label: string; status: Status; detail: string }>;
  verdict: "clean" | "caution" | "risky";
  sellTest: {
    status: "passed" | "failed" | "unknown";
    buyTaxPercent: number | null;
    sellTaxPercent: number | null;
    roundTripPercent: number | null;
  } | null;
  lookalikes: Array<{ address: string; symbol: string | null }>;
  limits: string[];
}

interface WalletReport {
  address: string;
  isContract: boolean;
  eth: string | null;
  holdings: Array<{ token: string; name: string | null; symbol: string | null; balance: string }>;
  holdingsTotal: number;
  approvals: Array<{
    token: string;
    tokenName: string | null;
    tokenSymbol: string | null;
    spender: { address: string; kind: string; label: string | null };
    unlimited: boolean;
    allowance: string;
    risk: "ok" | "warn" | "risk";
    reasons: string[];
  }>;
  /** Lookalike addresses planted in the wallet's history; missing from older servers. */
  poisoning?: Array<{
    address: string;
    resembles: string | null;
    resemblesSelf: boolean;
    kind: "dust" | "zero-transfer";
    tokenSymbol: string | null;
    risk: "risk" | "warn";
  }>;
  limits: string[];
}

interface Response<T> {
  report: T;
  url: string;
  remaining: number;
  limit: number;
}

/** Exit codes: 0 done, 1 couldn't check, 2 the result met --fail-on. */
export const EXIT_FAILED_CHECK = 2;

export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.MOFU_API_URL ?? "https://mofu.works").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error("MOFU_API_URL must be an https:// origin (or http://localhost for testing).");
  }
  return base;
}

class ApiFailure extends Error {}

async function api<T>(
  path: string,
  version: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; body: T }> {
  let res: globalThis.Response;
  try {
    res = await fetchFn(`${apiBase()}${path}`, {
      ...init,
      headers: {
        "User-Agent": `mofu-cli/${version}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new ApiFailure("Couldn't reach mofu.works. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as
    (T & { error?: { message?: string } }) | null;
  if (!res.ok || !body) {
    throw new ApiFailure(body?.error?.message ?? `mofu.works answered with HTTP ${res.status}.`);
  }
  return { status: res.status, body };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const MARK: Record<Status, string> = {
  ok: pc.green("✓"),
  info: pc.dim("·"),
  warn: pc.yellow("!"),
  risk: pc.red("✗"),
};
const VERDICT = {
  clean: pc.green(pc.bold("CLEAN")),
  caution: pc.yellow(pc.bold("CAUTION")),
  risky: pc.red(pc.bold("RISKY")),
};
const pct = (n: number | null) => (n === null ? "?" : `${n}%`);

/** The lines `mofu scan` prints for a report. */
export function formatTokenReport(r: TokenReport, url: string): string[] {
  const name = [r.token.symbol && `$${r.token.symbol}`, r.token.name].filter(Boolean).join("  ");
  const out = [
    `${pc.bold(name || "Unnamed token")}  ${pc.dim(`${short(r.address)} · Robinhood Chain`)}`,
  ];
  if (!r.isContract) {
    out.push(
      pc.yellow("This address isn't a contract. To check a wallet, run: mofu wallet " + r.address),
    );
    return out;
  }
  out.push(`Verdict: ${VERDICT[r.verdict]}`, "");
  const width = Math.max(...r.checks.map((c) => c.label.length), 8);
  for (const c of r.checks) {
    const text = c.status === "ok" ? pc.dim(c.detail) : c.detail;
    out.push(`  ${MARK[c.status]} ${c.label.padEnd(width)}  ${text}`);
  }
  // The "Can you sell it?" check already says it; the summary is for reports without that check.
  const sellCheck = r.checks.some((c) => c.id === "sell");
  if (sellCheck) {
    // nothing to add
  } else if (r.sellTest?.status === "passed") {
    const back =
      r.sellTest.roundTripPercent !== null
        ? ` · ${r.sellTest.roundTripPercent}% of the ETH back`
        : "";
    out.push(
      "",
      `  Sell test: ${pc.green("passed")} · buy tax ${pct(r.sellTest.buyTaxPercent)} · sell tax ${pct(r.sellTest.sellTaxPercent)}${back}`,
    );
  } else if (r.sellTest?.status === "failed") {
    out.push("", `  Sell test: ${pc.red(pc.bold("FAILED"))}: a simulated sell didn't go through.`);
  }
  if (r.lookalikes.length)
    out.push(
      `  ${pc.yellow(`${r.lookalikes.length} other token(s)`)} use the same name or ticker.`,
    );
  out.push("", pc.dim(`Full report: ${url}`));
  return out;
}

/** The lines `mofu wallet` prints for a report. */
export function formatWalletReport(r: WalletReport, url: string): string[] {
  const risky = r.approvals.filter((a) => a.risk === "risk").length;
  const unlimited = r.approvals.filter((a) => a.unlimited).length;
  const out = [
    `${pc.bold("Wallet")} ${r.address}${r.eth ? pc.dim(` · ${r.eth} ETH`) : ""}`,
    `Approvals: ${pc.bold(String(r.approvals.length))} · risky ${risky ? pc.red(pc.bold(String(risky))) : pc.green("0")} · unlimited ${unlimited ? pc.yellow(String(unlimited)) : "0"}`,
  ];
  if (r.approvals.length) out.push("");
  for (const a of r.approvals.slice(0, 25)) {
    const tag =
      a.risk === "risk" ? pc.red("RISK") : a.risk === "warn" ? pc.yellow("WARN") : pc.green(" OK ");
    const token = a.tokenSymbol ? `$${a.tokenSymbol}` : short(a.token);
    const who = a.spender.label ?? `${short(a.spender.address)} (${a.spender.kind})`;
    out.push(
      `  ${tag}  ${token.padEnd(12)} → ${who}  ${pc.dim(a.unlimited ? "unlimited" : a.allowance)}`,
    );
    if (a.risk !== "ok" && a.reasons[0]) out.push(pc.dim(`        ${a.reasons[0]}`));
  }
  if (r.approvals.length > 25)
    out.push(pc.dim(`  …and ${r.approvals.length - 25} more (see --json)`));
  const poison = r.poisoning ?? [];
  if (poison.length) {
    out.push("", pc.red(pc.bold(`Lookalike addresses in your history (${poison.length}):`)));
    for (const p of poison) {
      const what = p.resembles
        ? p.resemblesSelf
          ? "looks like your own address"
          : `looks like ${p.resembles}, which you've sent to`
        : "made a 0-token transfer you didn't send";
      out.push(
        `  ${p.risk === "risk" ? pc.red("RISK") : pc.yellow("WARN")}  ${p.address}  ${what}`,
      );
    }
    out.push(pc.dim("  Never copy an address from your history: these are planted by scammers."));
  }
  if (r.holdings.length) {
    out.push(
      "",
      `Holdings${r.holdingsTotal > r.holdings.length ? pc.dim(` (top ${r.holdings.length} of ${r.holdingsTotal})`) : ""}:`,
    );
    for (const h of r.holdings.slice(0, 10))
      out.push(`  ${(h.symbol ? `$${h.symbol}` : short(h.token)).padEnd(14)} ${h.balance}`);
  }
  out.push("", pc.dim(`Revoke approvals in your browser: ${url}`));
  return out;
}

/** Whether a result should fail the command under --fail-on. */
export function failsToken(r: TokenReport, failOn: ChainArgs["failOn"]): boolean {
  if (!failOn || !r.isContract) return false;
  return failOn === "caution" ? r.verdict !== "clean" : r.verdict === "risky";
}
export function failsWallet(r: WalletReport, failOn: ChainArgs["failOn"]): boolean {
  if (!failOn) return false;
  return r.approvals.some((a) => a.risk === "risk" || (failOn === "caution" && a.risk === "warn"));
}

export async function runChain(
  args: ChainArgs,
  printer: Printer,
  version: string,
): Promise<number> {
  try {
    if (!args.json)
      printer.line(
        pc.dim(
          args.command === "scan"
            ? "Scanning on Robinhood Chain…"
            : "Reading the wallet on Robinhood Chain…",
        ),
      );
    if (args.command === "scan") {
      const { body } = await api<Response<TokenReport>>(`/api/v1/token/${args.address}`, version);
      if (args.json) printer.line(JSON.stringify(body.report, null, 2));
      else {
        for (const l of formatTokenReport(body.report, body.url)) printer.line(l);
        printer.line(pc.dim(`${body.remaining} of ${body.limit} free checks left today`));
      }
      return failsToken(body.report, args.failOn) ? EXIT_FAILED_CHECK : 0;
    }
    const { body } = await api<Response<WalletReport>>(`/api/v1/wallet/${args.address}`, version);
    if (args.json) printer.line(JSON.stringify(body.report, null, 2));
    else {
      for (const l of formatWalletReport(body.report, body.url)) printer.line(l);
      printer.line(pc.dim(`${body.remaining} of ${body.limit} free checks left today`));
    }
    return failsWallet(body.report, args.failOn) ? EXIT_FAILED_CHECK : 0;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

interface Hook {
  id: string;
  url: string;
  tokens: string[];
  events: string[];
  status: string;
  delivered: number;
  failures: number;
  lastDeliveryAt: string | null;
  lastResult: string | null;
}

function printHook(h: Hook, printer: Printer) {
  printer.line(
    `${pc.bold(h.id)}  ${h.status === "active" ? pc.green("active") : pc.red(h.status)}`,
  );
  printer.line(`  URL:     ${h.url}`);
  printer.line(`  Tokens:  ${h.tokens.join(", ")}`);
  printer.line(`  Events:  ${h.events.join(", ")}`);
  printer.line(
    pc.dim(
      `  Delivered ${h.delivered}, failing in a row ${h.failures}${h.lastDeliveryAt ? `, last ${h.lastDeliveryAt} (${h.lastResult})` : ""}`,
    ),
  );
}

export async function runWebhook(
  args: WebhookArgs,
  printer: Printer,
  version: string,
): Promise<number> {
  try {
    if (args.sub === "add") {
      const { body } = await api<{ webhook: Hook; secret: string }>("/api/v1/webhooks", version, {
        method: "POST",
        body: JSON.stringify({
          url: args.url,
          tokens: args.tokens,
          ...(args.events && { events: args.events }),
        }),
      });
      if (args.json) {
        printer.line(JSON.stringify(body, null, 2));
        return 0;
      }
      printer.line(pc.green("Webhook created. Your URL answered Mofu's ping."));
      printHook(body.webhook, printer);
      printer.line("");
      printer.line(`  Secret:  ${pc.bold(body.secret)}`);
      printer.line(
        pc.yellow(
          "  Save the secret now; it isn't shown again. It verifies the Mofu-Signature header and manages this webhook.",
        ),
      );
      printer.line(
        pc.dim(
          `  Check it later: MOFU_WEBHOOK_SECRET=<secret> mofu webhook status ${body.webhook.id}`,
        ),
      );
      return 0;
    }
    const secret = args.secret ?? process.env.MOFU_WEBHOOK_SECRET;
    if (!secret) {
      printer.error("Pass the webhook's secret with --secret or the MOFU_WEBHOOK_SECRET variable.");
      return 1;
    }
    const auth = { Authorization: `Bearer ${secret}` };
    const path = `/api/v1/webhooks/${args.id}`;
    if (args.sub === "status") {
      const { body } = await api<{ webhook: Hook }>(path, version, { headers: auth });
      if (args.json) printer.line(JSON.stringify(body.webhook, null, 2));
      else printHook(body.webhook, printer);
      return 0;
    }
    if (args.sub === "test") {
      const { body } = await api<{ delivered: boolean; result: string }>(`${path}/test`, version, {
        method: "POST",
        headers: auth,
      });
      printer.line(
        body.delivered
          ? pc.green(`Test event delivered (HTTP ${body.result}).`)
          : pc.red(`Test event not delivered: ${body.result}.`),
      );
      return body.delivered ? 0 : 1;
    }
    await api(path, version, { method: "DELETE", headers: auth });
    printer.line(pc.green(`Deleted ${args.id}.`));
    return 0;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

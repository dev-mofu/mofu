/**
 * Public token pages: mofu.works/token/0x… (a server-rendered scan summary search engines can
 * index), its share card /token/0x….png, the list of scanned tokens at /token/ and their sitemap.
 *
 * Everything shown comes from the summary scan (no holder list, no creator), the same view anyone
 * gets in the app without holding $MOFU. Token names and symbols are set by whoever deployed the
 * contract, so they're always escaped.
 */
import { Hono, type Context } from "hono";
import type { TokenCheck, TokenScanReport } from "../shared/api.js";
import type { AppDeps } from "./app.js";
import { parseRpcUrls } from "./chain.js";
import { isAddress } from "./holder.js";
import {
  summarizeCreators,
  tokenIndexFromEnv,
  type CreatorEntry,
  type CreatorSummary,
  type IndexedToken,
} from "./stats.js";
import { renderTokenCard, shortAddress, VERDICT_TEXT } from "./token-card.js";
import { scanToken, summaryOnly } from "./token-scan.js";
import { withLookalikes } from "./lookalike.js";
import { queueVerdict } from "./verdict-store.js";

const ORIGIN = "https://mofu.works";
const REPORT_TTL = 30 * 60;
const CARD_TTL = 60 * 60;

type PagesContext = Context<{ Bindings: Env }>;

export type PagesDeps = AppDeps;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const escapeXml = escapeHtml;

/** Name and symbol as one line, e.g. "Mofu ($MOFU)". */
export function tokenTitle(t: { name: string | null; symbol: string | null }, address: string) {
  const name = clean(t.name);
  const symbol = clean(t.symbol);
  if (name && symbol) return `${name} ($${symbol})`;
  return name ?? (symbol ? `$${symbol}` : `Contract ${shortAddress(address)}`);
}

/** Control characters, zero-width and text-direction marks (they can disguise a name). */
const HIDDEN: Array<[number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/** Trims names to something printable: no control characters, at most 60 characters. */
function clean(s: string | null): string | null {
  if (!s) return null;
  const visible = [...s]
    .filter(
      (ch) => !HIDDEN.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi),
    )
    .join("")
    .trim();
  const out = [...visible].slice(0, 60).join("");
  return out || null;
}

const pct = (n: number | null) => (n === null ? null : `${Number(n.toFixed(n < 10 ? 2 : 1))}%`);

const STATUS_WORD: Record<TokenCheck["status"], [string, string]> = {
  ok: ["OK", "ok"],
  warn: ["Check", "warn"],
  risk: ["Risk", "bad"],
  info: ["Info", "info"],
};

const VERDICT_CLASS = { clean: "ok", caution: "warn", risky: "bad" } as const;

/** The page's description: verdict plus the facts people search for. */
export function describeToken(r: TokenScanReport): string {
  const title = tokenTitle(r.token, r.address);
  const has = (id: TokenCheck["id"]) => r.checks.find((k) => k.id === id)?.status;
  const facts = [
    `mint ${has("mint") === "ok" ? "off" : "possible"}`,
    `owner ${r.owner.status === "active" ? "active" : r.owner.status}`,
  ];
  const top = pct(r.distribution.top10Percent);
  if (top) facts.push(`top 10 hold ${top}`);
  return `${title} on Robinhood Chain: ${VERDICT_TEXT[r.verdict].toLowerCase()}. ${facts.join(", ")}. A free contract check by Mofu.`;
}

/** The main column of a token page. */
export function tokenMain(r: TokenScanReport, scannedAt: number): string {
  const a = r.address;
  const title = escapeHtml(tokenTitle(r.token, a));
  const verdict = VERDICT_TEXT[r.verdict];
  const pageUrl = `${ORIGIN}/token/${a}`;
  const shareText = `${tokenTitle(r.token, a)} on Robinhood Chain: ${verdict.toLowerCase()}. Checked with Mofu's Token Scanner.`;
  const shareX = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`;
  const checks = r.checks
    .map((k) => {
      const [word, cls] = STATUS_WORD[k.status];
      return `<li><span class="token-tag token-tag--${cls}">${word}</span> <strong>${escapeHtml(k.label)}</strong><br />${escapeHtml(k.detail)}</li>`;
    })
    .join("\n            ");
  const d = r.distribution;
  const holderFacts = [
    pct(d.top10Percent) &&
      `<li>The top 10 holders (burn addresses not counted) hold <strong>${pct(d.top10Percent)}</strong> of the supply. Pools and launch curves count as holders.</li>`,
    d.largestWallet &&
      `<li>The biggest plain wallet, <code>${shortAddress(d.largestWallet.address)}</code>, holds <strong>${pct(d.largestWallet.percent)}</strong>.</li>`,
    pct(r.burnedPercent) && `<li>Burned: <strong>${pct(r.burnedPercent)}</strong>.</li>`,
    r.token.totalSupply &&
      `<li>Total supply: ${escapeHtml(Number(r.token.totalSupply).toLocaleString("en-US"))}.</li>`,
  ].filter(Boolean);
  const limits = r.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const when = new Date(scannedAt).toUTCString().replace(/:\d\d GMT$/, " UTC");

  return `<header class="docs-hero">
          <div>
            <p class="token-kicker">Token scan · Robinhood Chain</p>
            <h1>${title}</h1>
            <p><span class="verify-verdict--${VERDICT_CLASS[r.verdict]}">${verdict}</span></p>
          </div>
        </header>

        <section id="summary">
          <div class="copy-wrap">
            <button class="code-chip" type="button" data-copy="${a}" aria-label="Copy the contract address">
              <span>${a}</span>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" shape-rendering="crispEdges"><path d="M5 1h9v9h-2V3H5zM2 5h8v10H2zm2 2v6h4V7z" /></svg>
            </button>
            <span class="copy-status" role="status" aria-live="polite"></span>
          </div>
          <img class="token-card" src="/token/${a}.png" width="1200" height="630" alt="Mofu's share card for ${title}: ${verdict}." />
          <div class="token-actions">
            <a class="pill pill--small" href="${shareX}" rel="noopener" target="_blank">Share on X</a>
            <button class="pill pill--small pill--ghost" type="button" data-copy="${pageUrl}">Copy link</button>
            <a class="pill pill--small pill--ghost" href="/app/?scan=${a}">Open the full scan</a>
          </div>
          <p class="token-note">Read from Robinhood Chain by Mofu's Token Scanner, ${when}. This checks what the contract code allows and who holds the supply. It isn't financial advice and can't tell you what a team will do.</p>
        </section>

        <section id="checks">
          <h2>What the code allows</h2>
          <ul class="token-checks">
            ${checks}
          </ul>
        </section>

        <section id="holders">
          <h2>Who holds it</h2>
          ${holderFacts.length ? `<ul>${holderFacts.join("")}</ul>` : "<p>Holder data isn't available for this token right now.</p>"}
          <p>The top holder list and who created the token are in the <a href="/app/?scan=${a}">full scan</a>, a perk for $MOFU holders.</p>
        </section>

        ${limits ? `<section id="limits"><h2>What this scan can't see</h2><ul>${limits}</ul></section>` : ""}

        <section id="badge">
          <h2>Show this scan on your site</h2>
          <p>A live badge that links back here. It updates when the scan does.</p>
          <p><img src="/token/${a}.svg" alt="Scanned by Mofu: ${verdict}" height="20" /></p>
          <pre><code>${escapeHtml(badgeSnippet(a, verdict))}</code></pre>
          <button class="pill pill--small pill--ghost token-copy" type="button" data-copy="${escapeHtml(badgeSnippet(a, verdict))}">Copy badge code</button>
          <h3>Or the full widget</h3>
          <p>A card with the verdict and the checks that matter most, for a launchpad, a project page or a listing. Two lines of HTML; it follows your visitor's light or dark mode.</p>
          <div class="token-widget-demo" data-mofu-token="${a}"></div>
          <script src="/widget.js" async></script>
          <pre><code>${escapeHtml(widgetSnippet(a))}</code></pre>
          <button class="pill pill--small pill--ghost token-copy" type="button" data-copy="${escapeHtml(widgetSnippet(a))}">Copy widget code</button>
        </section>

        <section id="more">
          <h2>Check another token</h2>
          ${lookupForm()}
          <p>Recently scanned: <a href="/token/">all tokens</a>. Who launches what: <a href="/creators/">token creators</a>. Mofu Guard runs the same check before you sign: <a href="/guard/">get the extension</a>.</p>
        </section>`;
}

const lookupForm = () => `<form class="token-form" action="/token/" method="get">
            <label for="token-address">Contract address</label>
            <div class="token-form-row">
              <input id="token-address" name="address" placeholder="0x…" required pattern="^0x[0-9a-fA-F]{40}$" autocomplete="off" spellcheck="false" />
              <button class="pill pill--small" type="submit">Scan</button>
            </div>
          </form>`;

export function indexMain(tokens: IndexedToken[]): string {
  const rows = tokens
    .map((t) => {
      const v = VERDICT_TEXT[t.verdict];
      return `<tr><td><a href="/token/${t.address}">${escapeHtml(tokenTitle(t, t.address))}</a></td><td><span class="verify-verdict--${VERDICT_CLASS[t.verdict]}">${v}</span></td><td><code>${shortAddress(t.address)}</code></td></tr>`;
    })
    .join("\n");
  return `<header class="docs-hero">
          <div>
            <h1>Token scans</h1>
            <p>Tokens on Robinhood Chain that people checked with Mofu, newest first.</p>
          </div>
        </header>
        <section id="lookup">
          <h2>Check a token</h2>
          ${lookupForm()}
          <p class="token-note">Free, no wallet needed. Mofu reads the contract's code and holdings on Robinhood Chain and tells you what the owner can do.</p>
        </section>
        <section id="recent">
          <h2>Recently scanned</h2>
          ${
            rows
              ? `<div class="table-wrap"><table><thead><tr><th scope="col">Token</th><th scope="col">Result</th><th scope="col">Contract</th></tr></thead><tbody>${rows}</tbody></table></div>`
              : "<p>No scans yet. Be the first.</p>"
          }
          <p class="token-note">A token shows up here after someone scans it in the app. Being listed isn't an endorsement. See also <a href="/creators/">token creators and their track records</a>.</p>
        </section>`;
}

const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

function creatorRows(list: CreatorSummary[]): string {
  return list
    .map(
      (s) =>
        `<tr><td><a href="/creator/${s.creator}"><code>${shortAddress(s.creator)}</code></a></td><td>${s.launches}</td><td>${s.honeypots ? `<span class="verify-verdict--bad">${s.honeypots}</span>` : "0"}</td><td>${s.risky}</td><td>${s.caution}</td><td>${s.clean}</td><td>${dateOf(s.last)}</td></tr>`,
    )
    .join("\n");
}

const creatorTable = (list: CreatorSummary[], empty: string) =>
  list.length
    ? `<div class="table-wrap"><table><thead><tr><th scope="col">Creator</th><th scope="col">Tokens scanned</th><th scope="col">Sell failed</th><th scope="col">Risky</th><th scope="col">Caution</th><th scope="col">Clean</th><th scope="col">Last scan</th></tr></thead><tbody>${creatorRows(list)}</tbody></table></div>`
    : `<p>${empty}</p>`;

/** The creator leaderboard: facts from Mofu's scans, grouped three ways. */
export function creatorsMain(board: CreatorSummary[]): string {
  const bad = board
    .filter((s) => s.honeypots > 0)
    .sort((a, b) => b.honeypots - a.honeypots || b.launches - a.launches)
    .slice(0, 50);
  const good = board
    .filter((s) => s.launches >= 2 && s.honeypots === 0 && s.risky === 0)
    .sort((a, b) => b.launches - a.launches || b.clean - a.clean)
    .slice(0, 50);
  const busy = [...board].sort((a, b) => b.launches - a.launches).slice(0, 50);
  return `<header class="docs-hero">
          <div>
            <h1>Token creators</h1>
            <p>Every wallet that created a token Mofu has scanned, and what Mofu found in those tokens.</p>
          </div>
        </header>
        <section id="about">
          <p class="token-note">These are results of Mofu's scans, counted per creator wallet since Nov 13, 2026: whether a token's simulated sell failed (or its code matched known honeypots), and the verdict at the time of the scan. They aren't accusations, and a token can change after it's scanned. ${board.length} creator${board.length === 1 ? "" : "s"} so far.</p>
        </section>
        <section id="sell-failed">
          <h2>Launched a token that failed the sell test</h2>
          ${creatorTable(bad, "None so far.")}
        </section>
        <section id="clean">
          <h2>Clean track records</h2>
          <p>Two or more tokens scanned, none risky, none failed the sell test.</p>
          ${creatorTable(good, "None with two or more scanned tokens yet.")}
        </section>
        <section id="most">
          <h2>Most launches</h2>
          ${creatorTable(busy, "No creators yet. They appear as tokens get scanned.")}
        </section>
        <section id="more">
          <h2>Check a token</h2>
          ${lookupForm()}
          <p>Every token scan shows its creator's track record under “What else did the creator launch?”.</p>
        </section>`;
}

/** One creator's tokens. */
export function creatorMain(creator: string, records: CreatorEntry[]): string {
  const s = summarizeCreators(records.map((e) => [`creator:${creator}:${e.address}`, e]))[0];
  const rows = records
    .map((e) => {
      const result = e.honeypot
        ? `<span class="verify-verdict--bad">Sell failed or honeypot code</span>`
        : `<span class="verify-verdict--${VERDICT_CLASS[e.verdict]}">${VERDICT_TEXT[e.verdict]}</span>`;
      return `<tr><td><a href="/token/${e.address}">${escapeHtml(e.symbol ? `$${e.symbol}` : shortAddress(e.address))}</a></td><td>${result}</td><td><code>${shortAddress(e.address)}</code></td><td>${dateOf(e.at)}</td></tr>`;
    })
    .join("\n");
  return `<header class="docs-hero">
          <div>
            <p class="token-kicker">Token creator · Robinhood Chain</p>
            <h1><code>${shortAddress(creator)}</code></h1>
          </div>
        </header>
        <section id="summary">
          <div class="copy-wrap">
            <button class="code-chip" type="button" data-copy="${creator}" aria-label="Copy the creator address">
              <span>${creator}</span>
            </button>
            <span class="copy-status" role="status" aria-live="polite"></span>
          </div>
          <p>${
            s
              ? `Mofu has scanned ${s.launches} token${s.launches === 1 ? "" : "s"} created by this wallet: ${s.honeypots} failed the sell test or matched honeypot code, ${s.risky} risky, ${s.caution} caution, ${s.clean} clean.`
              : "Mofu hasn't scanned a token created by this wallet yet."
          } <a href="https://robinhoodchain.blockscout.com/address/${creator}" rel="noopener" target="_blank">See the wallet on the explorer</a>.</p>
        </section>
        ${
          rows
            ? `<section id="tokens"><h2>Tokens</h2><div class="table-wrap"><table><thead><tr><th scope="col">Token</th><th scope="col">Mofu at the time</th><th scope="col">Contract</th><th scope="col">Scanned</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="token-note">The result is the verdict when Mofu scanned it, before the creator and launch checks. Open a token for its current scan.</p></section>`
            : ""
        }
        <section id="more"><p><a href="/creators/">All creators</a></p></section>`;
}

interface PageHead {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
}

function headHtml(h: PageHead): string {
  const image = h.image ?? `${ORIGIN}/og-card.png`;
  const alt =
    h.imageAlt ?? "The pixel mascot Mofu next to the words: the AI agent that does the work.";
  return [
    `<title>${escapeHtml(h.title)}</title>`,
    `<meta name="description" content="${escapeHtml(h.description)}" />`,
    `<link rel="canonical" href="${h.canonical}" />`,
    h.noindex ? `<meta name="robots" content="noindex" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(h.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(h.description)}" />`,
    `<meta property="og:url" content="${h.canonical}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeHtml(alt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(alt)}" />`,
  ]
    .filter(Boolean)
    .join("\n    ");
}

/** A bare page for tests and local runs without the built template. */
const FALLBACK_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><!--mofu:head--></head><body><main id="content"><!--mofu:main--></main></body></html>`;

async function template(c: PagesContext): Promise<string> {
  const assets = (c.env as Env & { ASSETS?: Fetcher }).ASSETS;
  if (!assets) return FALLBACK_TEMPLATE;
  try {
    const res = await assets.fetch(new URL("/token/", c.req.url));
    const html = res.ok ? await res.text() : "";
    return html.includes("<!--mofu:main-->") ? html : FALLBACK_TEMPLATE;
  } catch {
    return FALLBACK_TEMPLATE;
  }
}

async function page(c: PagesContext, head: PageHead, main: string, status = 200) {
  const html = (await template(c))
    .replace("<!--mofu:head-->", () => headHtml(head))
    .replace("<!--mofu:main-->", () => main);
  return c.html(html, status as 200, {
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

const cache = (): Cache | null =>
  typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;

export function createPagesApp(deps: PagesDeps) {
  const app = new Hono<{ Bindings: Env }>();
  const memory = new Map<string, { report: TokenScanReport; at: number }>();
  const index = (env: Env) => (deps.getTokenIndex ?? tokenIndexFromEnv)(env);
  const waitUntil = (c: PagesContext, p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // no execution context in tests
    }
  };

  /** A token-index read that falls back when the binding is missing or the call fails. */
  async function safely<T>(
    read: () => Promise<T | undefined> | undefined,
    fallback: T,
  ): Promise<T> {
    try {
      return (await read()) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** The summary scan for an address: memory, then the edge cache, then the chain. */
  async function report(
    c: PagesContext,
    address: string,
  ): Promise<{ report: TokenScanReport; at: number } | "limited" | "error"> {
    const now = deps.now();
    const hit = memory.get(address);
    if (hit && now - hit.at < REPORT_TTL * 1000) return hit;
    const key = new Request(`${ORIGIN}/__cache/token-report/${address}`);
    const edge = cache();
    const cached = await edge?.match(key).catch(() => undefined);
    if (cached) {
      const body = (await cached.json()) as { report: TokenScanReport; at: number };
      memory.set(address, body);
      return body;
    }
    // Uncached scans cost chain reads, so they're limited per IP like the app's scanner.
    const limit = Math.max(0, Number.parseInt(String(c.env.PAGE_DAILY_LIMIT ?? "300"), 10) || 0);
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    const usage = await deps.getLimiter(c.env).check(ip, limit, true, "pages");
    if (!usage.allowed) return "limited";
    const urls = parseRpcUrls(c.env.HOLDER_RPC_URL);
    if (urls.length === 0) return "error";
    const apiKey = (c.env as Env & { GOLDRUSH_API_KEY?: string }).GOLDRUSH_API_KEY;
    try {
      const data = apiKey
        ? {
            apiKey,
            chain: String(c.env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
            rpcUrls: urls,
            fetch: deps.fetch,
            now,
          }
        : undefined;
      const scanned = await scanToken(urls, address, deps.fetch, data);
      let idx: ReturnType<typeof index> | null = null;
      try {
        idx = index(c.env);
      } catch {
        idx = null;
      }
      const full = await withLookalikes(scanned, idx, data);
      queueVerdict(c.env, full, now, (p) => waitUntil(c, p));
      const body = { report: summaryOnly(full), at: now };
      memory.set(address, body);
      if (memory.size > 500) memory.clear();
      if (edge)
        waitUntil(
          c,
          edge
            .put(
              key,
              new Response(JSON.stringify(body), {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": `public, max-age=${REPORT_TTL}`,
                },
              }),
            )
            .catch(() => undefined),
        );
      return body;
    } catch {
      return "error";
    }
  }

  const notFound = (c: PagesContext, why: string) =>
    page(
      c,
      {
        title: "Token not found · Mofu",
        description: why,
        canonical: `${ORIGIN}/token/`,
        noindex: true,
      },
      `<header class="docs-hero"><div><h1>Nothing to show here</h1><p>${escapeHtml(why)}</p></div></header>
        <section id="lookup"><h2>Check a token</h2>${lookupForm()}</section>`,
      404,
    );

  const busy = (c: PagesContext, limited: boolean) =>
    page(
      c,
      {
        title: "Token scan · Mofu",
        description: "Try again in a minute.",
        canonical: `${ORIGIN}/token/`,
        noindex: true,
      },
      `<header class="docs-hero"><div><h1>${limited ? "That's a lot of scans" : "Robinhood Chain didn't answer"}</h1><p>${
        limited
          ? "This network has used today's page scans. Scans in the app still work."
          : "Mofu couldn't read the chain right now. Please try again in a minute."
      }</p></div></header>`,
      limited ? 429 : 503,
    );

  app.get("/token", (c) => c.redirect("/token/", 301));
  app.get("/creators", (c) => c.redirect("/creators/", 301));

  app.get("/creators/", async (c) => {
    const board = await safely(() => index(c.env).creatorBoard?.(), [] as CreatorSummary[]);
    return page(
      c,
      {
        title: "Token creators on Robinhood Chain · Mofu",
        description:
          "Wallets that created tokens Mofu has scanned on Robinhood Chain, with how many failed the sell test, were risky or came out clean.",
        canonical: `${ORIGIN}/creators/`,
      },
      creatorsMain(board),
    );
  });

  app.get("/creator/:id", async (c) => {
    const raw = c.req.param("id");
    if (!isAddress(raw)) return notFound(c, "That isn't a wallet address.");
    const creator = raw.toLowerCase();
    if (raw !== creator) return c.redirect(`/creator/${creator}`, 301);
    const records = await safely(
      () => index(c.env).creatorRecords?.(creator),
      [] as CreatorEntry[],
    );
    return page(
      c,
      {
        title: `Token creator ${shortAddress(creator)} · Mofu`,
        description: `Tokens created by ${creator} on Robinhood Chain and what Mofu's scans found in them.`,
        canonical: `${ORIGIN}/creator/${creator}`,
        noindex: true,
      },
      creatorMain(creator, records),
    );
  });

  app.get("/token/", async (c) => {
    const q = (c.req.query("address") ?? "").trim();
    if (q)
      return isAddress(q)
        ? c.redirect(`/token/${q.toLowerCase()}`, 302)
        : notFound(c, "That isn't a contract address: 0x followed by 40 characters.");
    const tokens = await index(c.env)
      .tokens(100)
      .catch(() => [] as IndexedToken[]);
    return page(
      c,
      {
        title: "Token scans on Robinhood Chain · Mofu",
        description:
          "Free contract checks for tokens on Robinhood Chain: can the owner mint, pause, blacklist or change the code, and who holds the supply.",
        canonical: `${ORIGIN}/token/`,
      },
      indexMain(tokens),
    );
  });

  app.get("/token/:id", async (c) => {
    const id = c.req.param("id");
    const png = id.endsWith(".png");
    const svg = id.endsWith(".svg");
    const json = id.endsWith(".json");
    const ext = png ? ".png" : svg ? ".svg" : json ? ".json" : "";
    const raw = ext ? id.slice(0, -ext.length) : id;
    if (!isAddress(raw)) return ext ? c.notFound() : notFound(c, "That isn't a contract address.");
    const address = raw.toLowerCase();
    if (raw !== address) return c.redirect(`/token/${address}${ext}`, 301);

    if (json) {
      // The "Checked by Mofu" widget reads this from any site.
      const r = await report(c, address);
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": typeof r === "string" ? "no-store" : "public, max-age=300",
      };
      if (r === "limited")
        return c.json(
          { error: "busy", message: "Too many new scans from this network today." },
          429,
          headers,
        );
      if (r === "error")
        return c.json(
          { error: "unavailable", message: "Robinhood Chain couldn't be read right now." },
          503,
          headers,
        );
      return c.json(widgetData(r.report, r.at), 200, headers);
    }

    if (svg) {
      const r = await report(c, address);
      const body =
        typeof r === "string" || !r.report.isContract ? badgeSvg(null) : badgeSvg(r.report.verdict);
      return c.body(body, 200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=1800",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
      });
    }

    if (png) {
      const edge = cache();
      const key = new Request(`${ORIGIN}/token/${address}.png`);
      const cached = await edge?.match(key).catch(() => undefined);
      if (cached) return cached;
      const r = await report(c, address);
      // No scan to draw: fall back to the site's own card.
      if (typeof r === "string") return c.redirect("/og-card.png", 302);
      const bytes = await renderTokenCard(r.report);
      const res = new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": `public, max-age=${CARD_TTL}`,
          "X-Content-Type-Options": "nosniff",
        },
      });
      if (edge)
        waitUntil(
          c,
          edge.put(key, res.clone()).catch(() => undefined),
        );
      return res;
    }

    const r = await report(c, address);
    if (r === "limited" || r === "error") return busy(c, r === "limited");
    if (!r.report.isContract)
      return notFound(
        c,
        "There's no contract at this address on Robinhood Chain. It may be a wallet.",
      );
    const title = tokenTitle(r.report.token, address);
    const isToken = Boolean(r.report.token.name || r.report.token.symbol);
    return page(
      c,
      {
        title: `${title} token scan: ${VERDICT_TEXT[r.report.verdict].toLowerCase()} · Mofu`,
        description: describeToken(r.report),
        canonical: `${ORIGIN}/token/${address}`,
        image: `${ORIGIN}/token/${address}.png`,
        imageAlt: `Mofu's scan of ${title}: ${VERDICT_TEXT[r.report.verdict]}.`,
        noindex: !isToken,
      },
      tokenMain(r.report, r.at),
    );
  });

  app.get("/sitemap-tokens.xml", async (c) => {
    const tokens = await index(c.env)
      .tokens()
      .catch(() => [] as IndexedToken[]);
    const urls = [
      `<url><loc>${ORIGIN}/token/</loc></url>`,
      `<url><loc>${ORIGIN}/creators/</loc></url>`,
      ...tokens.map(
        (t) =>
          `<url><loc>${ORIGIN}/token/${escapeXml(t.address)}</loc><lastmod>${new Date(t.at).toISOString().slice(0, 10)}</lastmod></url>`,
      ),
    ];
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
      200,
      { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    );
  });

  return app;
}

/** Paths the pages app answers (the rest of the site is static assets or the API). */
export const isPagesPath = (path: string) =>
  path === "/token" ||
  path.startsWith("/token/") ||
  path === "/creators" ||
  path === "/creators/" ||
  path.startsWith("/creator/") ||
  path === "/sitemap-tokens.xml";

/** What the "Checked by Mofu" widget shows: the verdict and the three checks that matter most. */
export function widgetData(r: TokenScanReport, scannedAt: number) {
  const rank = { risk: 0, warn: 1, ok: 2, info: 3 } as const;
  const flagged = r.checks
    .filter((k) => k.status === "risk" || k.status === "warn")
    .sort((a, b) => rank[a.status] - rank[b.status]);
  // Nothing flagged: show the reassuring checks people look for first.
  const key = ["sell", "liquidity", "mint", "bundle", "owner"];
  const fine = r.checks
    .filter((k) => k.status === "ok" && key.includes(k.id))
    .sort((a, b) => key.indexOf(a.id) - key.indexOf(b.id));
  const lines = (flagged.length ? flagged : fine)
    .slice(0, 3)
    .map((k) => ({ status: k.status, label: k.label }));
  return {
    address: r.address,
    isContract: r.isContract,
    name: r.token.name,
    symbol: r.token.symbol,
    verdict: r.verdict,
    counts: {
      risk: r.checks.filter((k) => k.status === "risk").length,
      warn: r.checks.filter((k) => k.status === "warn").length,
      ok: r.checks.filter((k) => k.status === "ok").length,
    },
    lines,
    scannedAt: new Date(scannedAt).toISOString(),
    url: `${ORIGIN}/token/${r.address}`,
  };
}

/** HTML for the widget: a placeholder and the script. */
export const widgetSnippet = (address: string) =>
  `<div data-mofu-token="${address}"></div>\n<script src="${ORIGIN}/widget.js" async></script>`;

/** HTML for embedding the badge. */
export const badgeSnippet = (address: string, verdict: string) =>
  `<a href="${ORIGIN}/token/${address}"><img src="${ORIGIN}/token/${address}.svg" alt="Scanned by Mofu: ${verdict}" height="20"></a>`;

const BADGE: Record<TokenScanReport["verdict"] | "none", [string, string]> = {
  clean: ["no red flags", "#2f9e6a"],
  caution: ["things to check", "#b7791f"],
  risky: ["strong owner control", "#c0392b"],
  none: ["not available", "#6b6468"],
};

/** A shields-style badge: "Scanned by Mofu | <verdict>". Only fixed words, never token text. */
export function badgeSvg(verdict: TokenScanReport["verdict"] | null): string {
  const [text, color] = BADGE[verdict ?? "none"];
  const left = "Scanned by Mofu";
  const lw = Math.round(left.length * 6.4 + 22);
  const rw = Math.round(text.length * 6.4 + 14);
  const w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${left}: ${text}"><title>${left}: ${text}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="4" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#1a1718"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><rect x="6" y="6" width="8" height="8" rx="2" fill="#ff4f9a"/><text x="${lw / 2 + 7}" y="14" text-anchor="middle">${left}</text><text x="${lw + rw / 2}" y="14" text-anchor="middle">${text}</text></g></svg>`;
}

/**
 * Labels on X: when a post on x.com shows a contract address that exists on Robinhood Chain,
 * Mofu Guard adds a small label at the end of the post with Mofu's verdict. Only posts on screen
 * are checked, a few at a time, and each address once (the background worker caches results).
 */
import type { ScanSummary } from "./messages.js";

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const HAS_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const TEXT_SELECTOR = '[data-testid="tweetText"], [data-testid="UserDescription"]';
/** Lookups per tab per 10 minutes: a long scroll shouldn't burn the day's checks. */
const BUDGET = 60;

export const isX = (host: string) => /(^|\.)(x|twitter)\.com$/.test(host);

/** Contract addresses in a post's text, unique, at most 3. */
export function addressesIn(text: string): string[] {
  return [...new Set([...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase()))].slice(0, 3);
}

const STYLE = `
  :host { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  a { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px;
    border-radius: 999px; font: 600 12.5px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    border: 1px solid var(--c); color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
  a:hover { background: color-mix(in srgb, var(--c) 22%, transparent); }
  i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  b { font-weight: 800; letter-spacing: .3px; }
`;
const VERDICT = {
  clean: { color: "#2fb67a", word: "CLEAN" },
  caution: { color: "#e0a030", word: "CAUTION" },
  risky: { color: "#ff5a5a", word: "RISKY" },
} as const;

function label(results: ScanSummary[]): HTMLElement {
  const el = document.createElement("mofu-x-label");
  const shadow = el.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.append(style);
  for (const r of results) {
    const v = VERDICT[r.verdict];
    const a = document.createElement("a");
    a.style.setProperty("--c", v.color);
    a.href = `https://mofu.works/token/${r.address}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = r.risks.length ? r.risks.slice(0, 2).join(" ") : "Mofu's scan on Robinhood Chain";
    const dot = document.createElement("i");
    const word = document.createElement("b");
    word.textContent = v.word;
    const name = document.createElement("span");
    name.textContent = `Mofu${r.symbol ? ` · $${r.symbol}` : ""}`;
    a.append(dot, name, word);
    // Clicks shouldn't open the post underneath.
    a.addEventListener("click", (e) => e.stopPropagation());
    shadow.append(a);
  }
  return el;
}

export function startXLabels(
  enabled: () => boolean,
  scan: (address: string) => Promise<ScanSummary | null>,
): void {
  const done = new WeakSet<Element>();
  let spent = 0;
  const reset = window.setInterval(() => (spent = 0), 10 * 60 * 1000);
  void reset;

  const handle = async (el: Element) => {
    if (done.has(el) || !enabled()) return;
    done.add(el);
    const addresses = addressesIn(el.textContent ?? "");
    if (!addresses.length || spent + addresses.length > BUDGET) return;
    spent += addresses.length;
    const results = (await Promise.all(addresses.map((a) => scan(a).catch(() => null)))).filter(
      (r): r is ScanSummary => !!r && r.isContract,
    );
    if (!results.length || !el.isConnected) return;
    if (el.querySelector(":scope > mofu-x-label")) return;
    el.append(label(results));
  };

  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        seen.unobserve(e.target);
        void handle(e.target);
      }
    },
    { rootMargin: "200px" },
  );
  const watch = () => {
    for (const el of document.querySelectorAll(TEXT_SELECTOR)) {
      if (!done.has(el) && HAS_ADDRESS.test(el.textContent ?? "")) seen.observe(el);
    }
  };
  let timer = 0;
  new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(watch, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  watch();
}

/**
 * Isolated content script: receives signing requests from the page, asks the background worker
 * to analyze them, and shows the Mofu Guard panel. Also shows a scan tooltip when you hover a
 * contract address on any page (without changing the page's text).
 */
import type { Analysis, Finding } from "./decode.js";
import type { GuardSettings, ScanSummary } from "./messages.js";

const IN = "mofu-guard:inpage";
const OUT = "mofu-guard:content";

let settings: GuardSettings = { protection: true, hover: true };
chrome.storage.sync.get(["protection", "hover"]).then((s) => {
  settings = { protection: s.protection !== false, hover: s.hover !== false };
});
chrome.storage.onChanged.addListener((c) => {
  if (c.protection) settings.protection = c.protection.newValue !== false;
  if (c.hover) settings.hover = c.hover.newValue !== false;
});

// ---------------------------------------------------------------- shadow root for our UI
const host = document.createElement("mofu-guard-root");
host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; inset: 0 auto auto 0;";
const root = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .backdrop { position: fixed; inset: 0; background: rgba(8, 5, 10, 0.62); backdrop-filter: blur(3px);
    display: grid; place-items: center; padding: 16px; animation: fade .15s ease-out; }
  @keyframes fade { from { opacity: 0; } }
  .panel { width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: #1a1418;
    color: #f4f0f1; border-radius: 20px; border: 2px solid var(--edge); box-shadow: 0 0 60px var(--glow); }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px;
    background: var(--tint); border-radius: 18px 18px 0 0; }
  .brand { font-family: "VT323", ui-monospace, monospace; font-size: 22px; letter-spacing: 3px; color: var(--edge); }
  .badge { font-weight: 800; font-size: 13px; letter-spacing: 1px; color: #1a0d10; background: var(--edge);
    padding: 4px 10px; border-radius: 999px; }
  .body { padding: 16px 20px 20px; }
  h2 { margin: 0 0 6px; font-size: 21px; line-height: 1.25; }
  .site { margin: 0 0 12px; font-size: 12.5px; color: #a8a0a3; }
  .lines p { margin: 0 0 8px; font-size: 14.5px; line-height: 1.45; color: #e6dde1; }
  ul { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
  li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; align-items: start; font-size: 14px; line-height: 1.4; }
  .ico { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px;
    font-weight: 800; border: 2px solid currentColor; }
  .risk { color: #ff6b6b; } .warn { color: #f2b84b; } .ok { color: #5bd394; } .info { color: #a8a0a3; }
  li span.t { color: #f4f0f1; }
  .loading { margin-top: 10px; font-size: 13px; color: #a8a0a3; }
  .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button { cursor: pointer; border-radius: 999px; padding: 11px 18px; font-size: 15px; font-weight: 700; border: 0; }
  .stop { background: #ff5a5a; color: #1a0d10; flex: 1; }
  .go { background: transparent; color: #f4f0f1; border: 1.5px solid #5a4650; flex: 1; }
  .safe .stop { background: transparent; color: #f4f0f1; border: 1.5px solid #5a4650; }
  .safe .go { background: #f6f1f3; color: #141112; border: 0; }
  .foot { margin-top: 12px; font-size: 12px; color: #8f878b; }
  .foot a { color: #ff8fc0; }
  .tip { position: fixed; width: 290px; background: #1a1418; color: #f4f0f1; border: 1.5px solid #ff4f9a;
    border-radius: 14px; padding: 10px 12px; font-size: 13px; line-height: 1.4; box-shadow: 0 10px 40px rgba(0,0,0,.5);
    pointer-events: auto; }
  .tip b { font-size: 14px; } .tip .v { margin: 4px 0; font-weight: 700; }
  .tip a { color: #ff8fc0; text-decoration: none; } .tip small { color: #a8a0a3; }
`;
root.append(style);
const mount = () => {
  if (!host.isConnected) (document.body ?? document.documentElement).append(host);
};

// ---------------------------------------------------------------- signing panel
const ICON: Record<Finding["level"], string> = { risk: "✕", warn: "!", ok: "✓", info: "i" };

function panel(analyses: Analysis[], origin: string, loading: boolean): Promise<boolean> {
  mount();
  const levels = analyses.flatMap((a) => a.findings.map((f) => f.level));
  const tone = levels.includes("risk") ? "risk" : levels.includes("warn") ? "warn" : "safe";
  const theme =
    tone === "risk"
      ? {
          edge: "#ff5a5a",
          tint: "rgba(255,90,90,0.14)",
          glow: "rgba(255,90,90,0.35)",
          badge: "STOP",
        }
      : tone === "warn"
        ? {
            edge: "#f2b84b",
            tint: "rgba(242,184,75,0.12)",
            glow: "rgba(242,184,75,0.3)",
            badge: "CHECK",
          }
        : {
            edge: "#5bd394",
            tint: "rgba(91,211,148,0.1)",
            glow: "rgba(91,211,148,0.25)",
            badge: "LOOKS OK",
          };

  const backdrop = document.createElement("div");
  backdrop.className = `backdrop ${tone === "safe" ? "safe" : ""}`;
  backdrop.style.setProperty("--edge", theme.edge);
  backdrop.style.setProperty("--tint", theme.tint);
  backdrop.style.setProperty("--glow", theme.glow);
  const el = (tag: string, cls?: string, text?: string) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const p = el("div", "panel");
  p.setAttribute("role", "dialog");
  p.setAttribute("aria-modal", "true");
  const head = el("div", "head");
  head.append(el("span", "brand", "MOFU GUARD"), el("span", "badge", theme.badge));
  const body = el("div", "body");
  body.append(
    el(
      "h2",
      undefined,
      analyses.length > 1 ? `${analyses.length} actions in one request` : analyses[0]!.title,
    ),
  );
  body.append(el("p", "site", `Requested by ${origin}`));
  const lines = el("div", "lines");
  for (const a of analyses) for (const l of a.lines) lines.append(el("p", undefined, l));
  body.append(lines);
  const list = el("ul");
  for (const a of analyses)
    for (const f of a.findings) {
      const li = el("li", f.level);
      li.append(el("span", "ico", ICON[f.level]), el("span", "t", f.text));
      list.append(li);
    }
  if (list.childElementCount) body.append(list);
  if (loading) body.append(el("p", "loading", "Checking the contract on Robinhood Chain…"));
  const actions = el("div", "actions");
  const stop = el("button", "stop", "Don't sign") as HTMLButtonElement;
  const go = el(
    "button",
    "go",
    tone === "risk" ? "Continue anyway" : "Continue",
  ) as HTMLButtonElement;
  actions.append(stop, go);
  body.append(actions);
  const foot = el("p", "foot");
  foot.append("Mofu Guard only reads and warns. It never signs for you. ");
  if (analyses[0]?.token) {
    const link = el("a", undefined, "Full scan on mofu.works") as HTMLAnchorElement;
    link.href = `https://mofu.works/app/?scan=${analyses[0].token}`;
    link.target = "_blank";
    link.rel = "noopener";
    foot.append(link);
  }
  body.append(foot);
  p.append(head, body);
  backdrop.append(p);
  root.append(backdrop);
  stop.focus();

  return new Promise((resolve) => {
    const finish = (allow: boolean) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(allow);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    stop.addEventListener("click", () => finish(false));
    go.addEventListener("click", () => finish(true));
  });
}

window.addEventListener("message", async (e) => {
  if (e.source !== window || e.data?.source !== IN || typeof e.data.id !== "number") return;
  const { id, method, params, chainId, origin } = e.data as {
    id: number;
    method: string;
    params: unknown[];
    chainId: string | null;
    origin: string;
  };
  window.postMessage({ source: OUT, ack: id }, "*");
  const reply = (allow: boolean) => window.postMessage({ source: OUT, id, allow }, "*");
  if (!settings.protection) return reply(true);
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "analyze",
      method,
      params,
      chainId,
    })) as {
      analyses: Analysis[];
    };
    const analyses = result?.analyses ?? [];
    if (!analyses.some((a) => a.prompt)) return reply(true);
    const allow = await panel(analyses, origin, false);
    // An anonymous count for mofu.works/stats: nothing about the request or the wallet.
    if (!allow) void chrome.runtime.sendMessage({ type: "stopped" }).catch(() => undefined);
    reply(allow);
  } catch {
    // The extension was updated or reloaded mid-request: don't block the user.
    reply(true);
  }
});

// ---------------------------------------------------------------- hover scan on addresses
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
let hoverTimer = 0;
let tip: HTMLElement | null = null;
let tipFor = "";

function addressAt(x: number, y: number): string | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    const r = doc.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  for (const m of text.matchAll(ADDRESS)) {
    if (m.index! <= offset && offset <= m.index! + m[0].length) return m[0].toLowerCase();
  }
  return null;
}

function hideTip() {
  tip?.remove();
  tip = null;
  tipFor = "";
}

async function showTip(address: string, x: number, y: number) {
  mount();
  hideTip();
  tipFor = address;
  tip = document.createElement("div");
  tip.className = "tip";
  tip.style.left = `${Math.min(x + 14, innerWidth - 306)}px`;
  tip.style.top = `${Math.min(y + 16, innerHeight - 150)}px`;
  tip.textContent = "Mofu is scanning this address on Robinhood Chain…";
  root.append(tip);
  const r = (await chrome.runtime
    .sendMessage({ type: "scan", address })
    .catch(() => null)) as ScanSummary | null;
  if (!tip || tipFor !== address) return;
  tip.textContent = "";
  const b = document.createElement("b");
  const v = document.createElement("div");
  v.className = "v";
  if (!r) {
    b.textContent = "Couldn't scan right now";
  } else if (!r.isContract) {
    b.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;
    v.textContent = "A wallet, not a contract (on Robinhood Chain).";
    v.style.color = "#a8a0a3";
  } else {
    b.textContent = r.name ? `${r.name}${r.symbol ? ` (${r.symbol})` : ""}` : "Contract";
    const verdict = {
      clean: ["No red flags in the code", "#5bd394"],
      caution: ["A few things to check", "#f2b84b"],
      risky: ["Someone has strong control", "#ff6b6b"],
    }[r.verdict];
    v.textContent = verdict[0]!;
    v.style.color = verdict[1]!;
  }
  tip.append(b, v);
  if (r?.risks.length) {
    const s = document.createElement("small");
    s.textContent = r.risks.slice(0, 2).join(" ");
    tip.append(s, document.createElement("br"));
  }
  const a = document.createElement("a");
  a.href = `https://mofu.works/app/?scan=${address}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Full report on mofu.works →";
  tip.append(a);
}

document.addEventListener(
  "mousemove",
  (e) => {
    if (!settings.hover) return;
    if (tip && e.composedPath().includes(host)) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      const address = addressAt(e.clientX, e.clientY);
      if (address && address !== tipFor) void showTip(address, e.clientX, e.clientY);
      else if (!address && tip) hideTip();
    }, 450);
  },
  { passive: true },
);
document.addEventListener("scroll", hideTip, { passive: true, capture: true });

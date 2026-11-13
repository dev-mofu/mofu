/**
 * Background service worker: analyzes signing requests (decode locally, then add Robinhood Chain
 * checks from mofu.works), answers hover scans, and adds "Scan with Mofu" to the context menu.
 * Nothing about the user's wallet is stored. Sent to Mofu: addresses being checked, and on
 * Robinhood Chain the transaction itself (from, to, value, data) so it can be simulated.
 */
import { analyzeRequest, enrich, ROBINHOOD_CHAIN_ID, type Analysis } from "./decode.js";
import { rememberRecipients, withPoisonCheck } from "./lookalike.js";
import { API, type ScanSummary } from "./messages.js";
import { judgePreview, previewRequest, type TxPreview } from "./preview.js";

const cache = new Map<string, { at: number; value: ScanSummary | null }>();
const TTL = 5 * 60 * 1000;

async function apiBase(): Promise<string> {
  // A dev override (set from the service worker console) for testing against a local server.
  const s = await chrome.storage.local.get("apiBase");
  return typeof s.apiBase === "string" && s.apiBase ? s.apiBase : API;
}

async function check(address: string, timeoutMs = 4000): Promise<ScanSummary | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const res = await fetch(`${await apiBase()}/api/guard/check?address=${key}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = res.ok ? ((await res.json()) as ScanSummary) : null;
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.clear();
    return value;
  } catch {
    return null;
  }
}

/** Addresses this browser has sent to through Mofu Guard (kept locally, never sent anywhere). */
async function recipients(): Promise<string[]> {
  const s = await chrome.storage.local.get("recipients");
  return Array.isArray(s.recipients) ? (s.recipients as string[]) : [];
}

/** Mofu's simulation of the transaction on Robinhood Chain; null when it can't be had in time. */
async function simulate(method: string, params: unknown[]): Promise<TxPreview | null> {
  const body = previewRequest(method, params);
  if (!body) return null;
  const base = await apiBase();
  const started = Date.now();
  // One retry when the first try fails fast (a busy RPC); the wallet never waits more than ~7 s.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${base}/api/guard/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(attempt === 0 ? 4500 : 2500),
      });
      if (res.ok) return (await res.json()) as TxPreview;
      if (res.status < 500) return null;
    } catch {
      // timeout or network: try again if there's time
    }
    if (Date.now() - started > 4500) return null;
  }
  return null;
}

async function analyze(
  method: string,
  params: unknown[],
  chainId: string | null,
): Promise<{ analyses: Analysis[]; preview: TxPreview | null }> {
  const from = (params[0] as { from?: unknown } | undefined)?.from;
  const known = {
    recipients: await recipients(),
    self: typeof from === "string" ? from : null,
  };
  const analyses = analyzeRequest(method, params).map((a) => withPoisonCheck(a, known));
  const chain = chainId ? Number.parseInt(chainId, 16) : NaN;
  if (chain !== ROBINHOOD_CHAIN_ID) return { analyses, preview: null };
  const [checked, preview] = await Promise.all([checkAll(analyses), simulate(method, params)]);
  if (!preview || checked.length === 0) return { analyses: checked, preview };
  // The preview's own findings ride on the first action.
  const judged = judgePreview(checked, preview);
  const [first, ...rest] = checked;
  return {
    analyses: [
      {
        ...first!,
        findings: [...judged.findings, ...first!.findings],
        prompt: first!.prompt || judged.prompt,
      },
      ...rest,
    ],
    preview,
  };
}

function checkAll(analyses: Analysis[]): Promise<Analysis[]> {
  return Promise.all(
    analyses.map(async (a) => {
      if (!a.token && !a.spender) return a;
      const [token, spender] = await Promise.all([
        a.token ? check(a.token) : Promise.resolve(null),
        a.spender ? check(a.spender) : Promise.resolve(null),
      ]);
      return enrich(a, {
        token: token && { ...token },
        spender: spender && { address: spender.address, isContract: spender.isContract },
      });
    }),
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "analyze") {
    analyze(String(msg.method), Array.isArray(msg.params) ? msg.params : [], msg.chainId ?? null)
      .then((result) => sendResponse(result))
      .catch(() =>
        sendResponse({
          analyses: analyzeRequest(String(msg.method), msg.params ?? []),
          preview: null,
        }),
      );
    return true;
  }
  if (msg?.type === "sent" && Array.isArray(msg.targets)) {
    const add = (msg.targets as unknown[]).filter((t): t is string => typeof t === "string");
    void recipients().then((list) =>
      chrome.storage.local.set({ recipients: rememberRecipients(list, add) }),
    );
    return false;
  }
  if (msg?.type === "stopped") {
    void apiBase()
      .then((base) => fetch(`${base}/api/guard/event?type=stopped`))
      .catch(() => undefined);
    return false;
  }
  if (
    msg?.type === "scan" &&
    typeof msg.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(msg.address)
  ) {
    check(msg.address, 8000).then(sendResponse);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- context menu
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: "mofu-scan", title: "Scan with Mofu", contexts: ["selection"] });
  if (details.reason === "install") {
    void chrome.storage.sync.set({ protection: true, hover: true });
    void chrome.tabs.create({ url: "https://mofu.works/guard/" });
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "mofu-scan") return;
  const text = (info.selectionText ?? "").trim();
  const tx = /0x[0-9a-fA-F]{64}/.exec(text)?.[0];
  const address = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
  const url = tx
    ? `https://mofu.works/app/?tx=${tx}`
    : address
      ? `https://mofu.works/app/?scan=${address}`
      : "https://mofu.works/app/?mode=dev&tool=token";
  void chrome.tabs.create({ url });
});

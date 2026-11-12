/**
 * Background service worker: analyzes signing requests (decode locally, then add Robinhood Chain
 * checks from mofu.works), answers hover scans, and adds "Scan with Mofu" to the context menu.
 * Nothing about the user's wallet is stored; only addresses being checked are sent to Mofu.
 */
import { analyzeRequest, enrich, ROBINHOOD_CHAIN_ID, type Analysis } from "./decode.js";
import { API, type ScanSummary } from "./messages.js";

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

async function analyze(
  method: string,
  params: unknown[],
  chainId: string | null,
): Promise<Analysis[]> {
  const analyses = analyzeRequest(method, params);
  const chain = chainId ? Number.parseInt(chainId, 16) : NaN;
  if (chain !== ROBINHOOD_CHAIN_ID) return analyses;
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
      .then((analyses) => sendResponse({ analyses }))
      .catch(() =>
        sendResponse({ analyses: analyzeRequest(String(msg.method), msg.params ?? []) }),
      );
    return true;
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

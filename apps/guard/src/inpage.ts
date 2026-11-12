/**
 * Runs in the page (MAIN world) at document_start. Wraps the wallet provider's request() so
 * signing requests pause until Mofu Guard's panel (in the extension's isolated content script)
 * says to continue. Covers window.ethereum, wallets that inject later, multi-wallet
 * window.ethereum.providers and EIP-6963 announced providers.
 */
import { WATCHED } from "./decode.js";

type RequestArgs = { method: string; params?: unknown[] | Record<string, unknown> };
interface Provider {
  request?: (args: RequestArgs) => Promise<unknown>;
  providers?: Provider[];
}

const IN = "mofu-guard:inpage";
const OUT = "mofu-guard:content";
const WRAPPED = Symbol.for("mofu-guard.wrapped");
let seq = 0;
const pending = new Map<number, (allow: boolean) => void>();

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== OUT || typeof e.data.id !== "number") return;
  const done = pending.get(e.data.id);
  if (!done) return;
  pending.delete(e.data.id);
  done(e.data.allow === true);
});

/** Asks the extension; if nothing answers (extension reloaded or disabled), the request goes through. */
function ask(method: string, params: unknown[], chainId: string | null): Promise<boolean> {
  const id = ++seq;
  return new Promise((resolve) => {
    let acked = false;
    pending.set(id, resolve);
    const onAck = (e: MessageEvent) => {
      if (e.source === window && e.data?.source === OUT && e.data.ack === id) acked = true;
    };
    window.addEventListener("message", onAck);
    window.postMessage({ source: IN, id, method, params, chainId, origin: location.origin }, "*");
    window.setTimeout(() => {
      window.removeEventListener("message", onAck);
      if (!acked && pending.has(id)) {
        pending.delete(id);
        resolve(true);
      }
    }, 1500);
  });
}

function wrap(provider: Provider | null | undefined) {
  if (!provider || typeof provider !== "object") return;
  for (const p of provider.providers ?? []) wrap(p);
  const record = provider as unknown as Record<symbol, boolean>;
  if (record[WRAPPED] || typeof provider.request !== "function") return;
  const original = provider.request.bind(provider);
  const guarded = async (args: RequestArgs) => {
    if (args && WATCHED.has(args.method)) {
      const params = Array.isArray(args.params) ? args.params : args.params ? [args.params] : [];
      const chainId = (await original({ method: "eth_chainId" }).catch(() => null)) as
        string | null;
      const allow = await ask(args.method, params, chainId);
      if (!allow) {
        throw Object.assign(new Error("Mofu Guard: you chose not to sign this request."), {
          code: 4001,
        });
      }
    }
    return original(args);
  };
  try {
    provider.request = guarded;
  } catch {
    // read-only property, handled below
  }
  if (provider.request !== guarded) {
    try {
      Object.defineProperty(provider, "request", {
        value: guarded,
        configurable: true,
        writable: true,
      });
    } catch {
      return;
    }
  }
  try {
    record[WRAPPED] = true;
  } catch {
    // frozen object; the request swap above already worked
  }
}

// window.ethereum: now, when a wallet assigns it later, and on the usual "initialized" event.
const w = window as unknown as { ethereum?: Provider };
let current = w.ethereum;
wrap(current);
if (!current) {
  try {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (v: Provider) => {
        current = v;
        wrap(v);
      },
    });
  } catch {
    // another script already defined it; the checks below still catch it
  }
}
window.addEventListener("ethereum#initialized", () => wrap(w.ethereum));
let checks = 0;
const timer = window.setInterval(() => {
  wrap(w.ethereum);
  if (++checks > 20) window.clearInterval(timer);
}, 500);

// EIP-6963: wallets announce themselves; wrap each announced provider.
window.addEventListener("eip6963:announceProvider", (e) => {
  wrap((e as CustomEvent<{ provider?: Provider }>).detail?.provider);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

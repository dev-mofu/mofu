/**
 * Fetching a web page for study without letting the server be pointed at
 * internal addresses (SSRF). Web-safe: DNS resolution is injected (DNS-over-
 * HTTPS in the Worker, dns.lookup in Node).
 */

export const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Resolves a hostname to its IP addresses. */
export type Resolver = (hostname: string) => Promise<string[]>;

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (v4 & mask) === (ipv4ToInt(base)! & mask);
    });
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (!v6.includes(":")) return true; // not an IP at all: refuse
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^fe[89ab]/.test(v6) || // link-local
    /^f[cd]/.test(v6) || // unique local
    /^ff/.test(v6) || // multicast
    v6.startsWith("64:ff9b:") // NAT64 can reach IPv4 internals
  );
}

/** Rejects anything but public http(s) URLs. */
export async function assertPublicUrl(raw: string, resolve: Resolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That isn't a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UnsafeUrlError("Only http and https links are supported.");
  if (url.username || url.password)
    throw new UnsafeUrlError("Links with credentials aren't supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
    throw new UnsafeUrlError("That address isn't public.");
  const literal = ipv4ToInt(host) !== null || host.includes(":");
  const addresses = literal ? [host] : await resolve(host).catch(() => []);
  if (!addresses.length) throw new UnsafeUrlError(`Couldn't resolve ${host}.`);
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError("That address isn't public.");
  return url;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

/** Fetches a public page, checking every redirect hop, with size and time limits. */
export async function fetchPublicPage(
  raw: string,
  resolve: Resolver,
  fetchFn: typeof fetch = fetch,
): Promise<FetchedPage> {
  let url = await assertPublicUrl(raw, resolve);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "Mofu/0.1 (study helper)" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("The page redirected without a destination.");
      url = await assertPublicUrl(new URL(location, url).toString(), resolve);
      continue;
    }
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)|application\/xhtml/.test(type)) {
      throw new Error(
        "That link isn't a web page or text (for PDFs, download the file and upload it).",
      );
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_PAGE_BYTES) throw new Error("That page is too large.");
    const body = await readCapped(res, MAX_PAGE_BYTES);
    if (/text\/plain/.test(type))
      return {
        url: url.toString(),
        title: url.pathname.split("/").pop() || url.hostname,
        text: body,
      };
    return { url: url.toString(), ...htmlToText(body, url.hostname) };
  }
  throw new Error("Too many redirects.");
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const c of chunks) {
    all.set(c.subarray(0, all.length - offset), offset);
    offset += c.byteLength;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );

/**
 * Readability-lite: drop scripts, navigation and chrome, prefer <article> or
 * <main>, keep paragraph breaks.
 */
export function htmlToText(
  html: string,
  fallbackTitle = "Web page",
): { title: string; text: string } {
  const title =
    decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim() || fallbackTitle;
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    // The <head> (title, meta) isn't content; without this the title is repeated as text.
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title>/gi, "")
    .replace(
      /<(script|style|noscript|svg|template|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
  const main =
    body.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? body.match(/<main\b[\s\S]*<\/main>/i)?.[0];
  if (main && main.length > 500) body = main;
  const text = decode(
    body
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre|figcaption)>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

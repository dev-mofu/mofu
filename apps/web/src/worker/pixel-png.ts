/**
 * A tiny pixel-art canvas that encodes to PNG in the Worker: an indexed-color bitmap, rectangles,
 * a 5×7 bitmap font and sprites. No image libraries, so share cards stay cheap to render.
 */

const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
  "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  $: ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
};

/** Upper-cases and swaps characters the font doesn't have. */
export function fontSafe(text: string): string {
  return [...text.toUpperCase()]
    .map((ch) => (FONT[ch] ? ch : ch === "·" ? "-" : ch === "…" ? "." : "?"))
    .join("");
}

export const textWidth = (text: string, scale: number) =>
  Math.max(0, text.length * 6 * scale - scale);

export class PixelCanvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    /** RGB hex colors; pixels hold an index into this list. */
    readonly palette: string[],
  ) {
    this.data = new Uint8Array(width * height);
  }

  rect(x: number, y: number, w: number, h: number, color: number) {
    const x0 = Math.max(0, Math.round(x)),
      x1 = Math.min(this.width, Math.round(x + w));
    const y0 = Math.max(0, Math.round(y)),
      y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0) return;
    for (let yy = y0; yy < y1; yy++)
      this.data.fill(color, yy * this.width + x0, yy * this.width + x1);
  }

  frame(x: number, y: number, w: number, h: number, t: number, color: number) {
    this.rect(x, y, w, t, color);
    this.rect(x, y + h - t, w, t, color);
    this.rect(x, y, t, h, color);
    this.rect(x + w - t, y, t, h, color);
  }

  /** Text in the 5×7 font, top-left at (x, y); returns the width drawn. */
  text(raw: string, x: number, y: number, scale: number, color: number): number {
    const s = fontSafe(raw);
    let cx = x;
    for (const ch of s) {
      const g = FONT[ch]!;
      for (let gy = 0; gy < 7; gy++)
        for (let gx = 0; gx < 5; gx++)
          if (g[gy]![gx] === "#") this.rect(cx + gx * scale, y + gy * scale, scale, scale, color);
      cx += 6 * scale;
    }
    return textWidth(s, scale);
  }

  /** A sprite grid of color keys ("." is transparent), mapped to palette indices. */
  sprite(grid: string[][], colors: Record<string, number>, x: number, y: number, px: number) {
    grid.forEach((row, gy) =>
      row.forEach((key, gx) => {
        const c = colors[key];
        if (c !== undefined) this.rect(x + gx * px, y + gy * px, px, px, c);
      }),
    );
  }

  async png(): Promise<Uint8Array> {
    const { width: w, height: h } = this;
    const raw = new Uint8Array((w + 1) * h);
    for (let y = 0; y < h; y++) raw.set(this.data.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
    const idat = await deflate(raw);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr.set([8, 3, 0, 0, 0], 8); // 8-bit, indexed color
    const plte = new Uint8Array(this.palette.length * 3);
    this.palette.forEach((hex, i) => {
      const n = Number.parseInt(hex.replace("#", ""), 16);
      plte.set([(n >> 16) & 255, (n >> 8) & 255, n & 255], i * 3);
    });
    return concat([
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      chunk("IHDR", ihdr),
      chunk("PLTE", plte),
      chunk("IDAT", idat),
      chunk("IEND", new Uint8Array(0)),
    ]);
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

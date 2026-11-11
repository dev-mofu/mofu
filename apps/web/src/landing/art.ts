/**
 * Original pixel art for the landing page, drawn from data on canvas so it
 * stays crisp at any size. Colors come from CSS variables (theme-aware).
 */

export interface Palette {
  /** "r,g,b" of the monochrome pixel ink. */
  ink: string;
  /** "r,g,b" of the pink accent. */
  accent: string;
  /** "r,g,b" of the page background (for solid, layered scenery). */
  bg: string;
}

function hexToRgb(hex: string): string | null {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m
    ? m
        .slice(1)
        .map((h) => parseInt(h, 16))
        .join(",")
    : null;
}

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  return {
    ink: css.getPropertyValue("--px-ink").trim() || "233,227,229",
    accent: css.getPropertyValue("--px-accent").trim() || "255,79,154",
    bg: hexToRgb(css.getPropertyValue("--bg")) ?? "15,13,14",
  };
}

/** An opaque color `t` of the way from the background to the ink (0 = background, 1 = ink). */
export function mix(p: Palette, t: number): string {
  const a = p.bg.split(",").map(Number);
  const b = p.ink.split(",").map(Number);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * t)).join(",")})`;
}

/** Sizes a canvas to its CSS box (or the given size) and returns a DPR-scaled context. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  w?: number,
  h?: number,
): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(w ?? rect.width));
  const height = Math.max(1, Math.round(h ?? rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  if (w !== undefined) canvas.style.width = `${width}px`;
  if (h !== undefined) canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (ctx) ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Deterministic random numbers, so the scenery is the same on every visit. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => {
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.fill();
};

const CLOUDS = [
  [
    "......xxxxxx..........",
    "...xxxxxxxxxxxx.......",
    "xxxxxxxxxxxxxxxxxxxxx.",
    "..xxxxxxxxxxxxxxxxxxxxx",
  ],
  ["....xxxxx.......", "..xxxxxxxxxxx...", "xxxxxxxxxxxxxxxx"],
  [".....xxxxxxx.....", "xxxxxxxxxxxxxxxxx", "...xxxxxxxxxxxx.."],
];

interface Star {
  x: number;
  y: number;
  phase: number;
  speed: number;
  big: boolean;
}

/** The hero's night sky: twinkling stars, a ringed moon, drifting clouds, mountains. */
// --- Planets -------------------------------------------------------------------------

/** 4×4 ordered dither thresholds, for shading spheres with dots. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
/** Light comes from the upper right, like the crescent moon's. */
const LIGHT = [0.6, -0.5, 0.62];

export interface PlanetSpec {
  /** Center in CSS pixels. */
  x: number;
  y: number;
  /** Radius in pixel cells. */
  r: number;
  kind: "ringed" | "moonlet" | "dwarf";
  phase: number;
}

/** Planets beside the headline on wide screens; on phones one small planet in the top gap. */
export function layoutPlanets(w: number, h: number): PlanetSpec[] {
  if (w >= 1100) {
    return [
      { x: w * 0.13, y: Math.min(h * 0.33, 380), r: 15, kind: "ringed", phase: 0 },
      { x: w * 0.89, y: Math.min(h * 0.52, 600), r: 8, kind: "moonlet", phase: 1.7 },
      { x: w * 0.25, y: Math.min(h * 0.66, 760), r: 4, kind: "dwarf", phase: 3.1 },
    ];
  }
  if (w >= 640) {
    return [
      { x: w * 0.12, y: 106, r: 7, kind: "ringed", phase: 0 },
      { x: w * 0.93, y: h * 0.55, r: 5, kind: "moonlet", phase: 1.7 },
      { x: w * 0.07, y: h * 0.62, r: 3, kind: "dwarf", phase: 3.1 },
    ];
  }
  return [{ x: w * 0.15, y: 98, r: 6, kind: "ringed", phase: 0 }];
}

interface SphereStyle {
  color: string;
  /** Number of cloud bands (0 for a plain sphere). */
  bands: number;
  /** A pink storm that rotates with the planet. */
  storm?: boolean;
  dim?: number;
}

/** A dithered, lit sphere of dots. `spin` turns its surface (bands and storm). */
function sphere(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: number,
  spin: number,
  pal: Palette,
  s: SphereStyle,
): void {
  const x0 = Math.round(cx / c);
  const y0 = Math.round(cy / c);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d2 = x * x + y * y;
      if (d2 > r * r) continue;
      const nx = x / r;
      const ny = y / r;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lambert = Math.max(0, nx * LIGHT[0]! + ny * LIGHT[1]! + nz * LIGHT[2]!);
      let shade = 0.12 + 0.88 * lambert;
      const lon = Math.atan2(nx, nz) + spin;
      if (s.bands) {
        shade *=
          0.68 + 0.32 * (0.5 + 0.5 * Math.sin(ny * s.bands * Math.PI + Math.sin(lon * 2) * 0.6));
      }
      if (shade < BAYER[((y + 64) & 3) * 4 + ((x + 64) & 3)]! * 0.85) continue;
      let color = s.color;
      if (s.storm) {
        const at = ((lon % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        if (Math.abs(at - 1.2) < 0.34 && Math.abs(ny - 0.3) < 0.13) color = pal.accent;
      }
      const rim = d2 > (r - 1.2) ** 2 && lambert > 0.25 ? 0.12 : 0;
      const alpha = Math.min(1, (0.3 + 0.7 * shade) * (s.dim ?? 1) + rim);
      ctx.fillStyle = `rgba(${color},${alpha.toFixed(3)})`;
      dot(ctx, (x0 + x) * c, (y0 + y) * c, c);
    }
  }
}

/** Half of a tilted, dotted ring; the gaps make its rotation visible. */
function ring(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  c: number,
  t: number,
  pal: Palette,
  half: "back" | "front",
): void {
  const tilt = -0.28;
  const bands = [
    { scale: 2.05, gap: 5, alpha: 0.8, speed: 0.00022 },
    { scale: 1.7, gap: 7, alpha: 0.5, speed: 0.0003 },
  ];
  for (const b of bands) {
    const R = r * b.scale;
    const n = Math.round(R * 4.2);
    for (let i = 0; i < n; i++) {
      if (i % b.gap === 0) continue;
      const a = (i / n) * Math.PI * 2 + t * b.speed;
      const behind = Math.sin(a) < 0;
      if ((half === "back") !== behind) continue;
      const ex = Math.cos(a) * R;
      const ey = Math.sin(a) * R * 0.3;
      const x = ex * Math.cos(tilt) - ey * Math.sin(tilt);
      const y = ex * Math.sin(tilt) + ey * Math.cos(tilt);
      // The planet hides the back of the ring.
      if (behind && x * x + y * y < r * r) continue;
      ctx.fillStyle = `rgba(${pal.ink},${(behind ? b.alpha * 0.45 : b.alpha).toFixed(3)})`;
      dot(ctx, cx + x * c - c / 2, cy + y * c - c / 2, c);
    }
  }
}

/** One frame of a planet: it floats gently, its surface turns, rings rotate, moons orbit. */
export function drawPlanet(
  ctx: CanvasRenderingContext2D,
  p: PlanetSpec,
  t: number,
  pal: Palette,
  c: number,
): void {
  const cx = p.x;
  const cy = p.y + Math.sin(t * 0.0006 + p.phase) * c;
  if (p.kind === "dwarf") {
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.0018 + p.phase);
    const R = p.r * c * 3.4;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    glow.addColorStop(0, `rgba(${pal.accent},${(0.2 + 0.18 * pulse).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${pal.accent},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    sphere(ctx, cx, cy, p.r, c, 0, pal, { color: pal.accent, bands: 0 });
    return;
  }
  if (p.kind === "ringed") {
    ring(ctx, cx, cy, p.r, c, t, pal, "back");
    sphere(ctx, cx, cy, p.r, c, t * 0.00012 + p.phase, pal, {
      color: pal.ink,
      bands: 5,
      storm: true,
    });
    ring(ctx, cx, cy, p.r, c, t, pal, "front");
    return;
  }
  // A planet with a small moon on a tilted orbit; the moon passes behind it.
  const a = t * 0.00045 + p.phase;
  const R = p.r * c * 2.4;
  const tilt = -0.35;
  const ox = Math.cos(a) * R;
  const oy = Math.sin(a) * R * 0.32;
  const mx = cx + ox * Math.cos(tilt) - oy * Math.sin(tilt);
  const my = cy + ox * Math.sin(tilt) + oy * Math.cos(tilt);
  const behind = Math.sin(a) < 0;
  const mr = Math.max(2, Math.round(p.r * 0.3));
  const hidden = behind && Math.hypot(mx - cx, my - cy) < p.r * c;
  if (behind && !hidden) sphere(ctx, mx, my, mr, c, 0, pal, { color: pal.ink, bands: 0, dim: 0.7 });
  sphere(ctx, cx, cy, p.r, c, t * 0.0002 + p.phase, pal, { color: pal.ink, bands: 3 });
  if (!behind) sphere(ctx, mx, my, mr, c, 0, pal, { color: pal.ink, bands: 0 });
}

export class NightSky {
  private stars: Star[] = [];
  private staticLayer: HTMLCanvasElement | null = null;
  private lights: Array<{ x: number; y: number; phase: number; pink: boolean }> = [];
  private planets: PlanetSpec[] = [];
  private moon: { x: number; y: number; r: number } | null = null;

  /**
   * The crescent moon, alive: a soft halo that breathes, a glint that sweeps along
   * its lit edge, a dotted ring that turns (hidden behind the moon), two tiny
   * satellites riding the ring, and a slow float.
   */
  private drawMoon(ctx: CanvasRenderingContext2D, t: number): void {
    const m = this.moon;
    if (!m) return;
    const c = this.cell;
    const { ink, accent } = this.palette;
    const r = m.r;
    const cx = m.x;
    const cy = m.y + Math.sin(t * 0.0005 + 0.8) * c * 0.8;

    const pulse = 0.5 + 0.5 * Math.sin(t * 0.0012);
    const R = r * c * 2.6;
    const halo = ctx.createRadialGradient(cx, cy, r * c * 0.5, cx, cy, R);
    halo.addColorStop(0, `rgba(${ink},${(0.05 + 0.05 * pulse).toFixed(3)})`);
    halo.addColorStop(1, `rgba(${ink},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    const tilt = -0.32;
    const ringPoint = (a: number) => {
      const ex = Math.cos(a) * r * 1.9;
      const ey = Math.sin(a) * r * 0.45;
      return {
        x: ex * Math.cos(tilt) - ey * Math.sin(tilt),
        y: ex * Math.sin(tilt) + ey * Math.cos(tilt),
      };
    };
    const n = Math.round(r * 12);
    const ringHalf = (back: boolean) => {
      for (let i = 0; i < n; i++) {
        if (i % 4 === 0) continue; // gaps show the ring turning
        const a = (i / n) * Math.PI * 2 + t * 0.00028;
        if (back !== Math.sin(a) < 0) continue;
        const p = ringPoint(a);
        if (back && p.x * p.x + p.y * p.y < r * r) continue;
        ctx.fillStyle = `rgba(${ink},${back ? 0.3 : 0.6})`;
        dot(ctx, cx + p.x * c - c / 2, cy + p.y * c - c / 2, c);
      }
    };
    const satellites = (back: boolean) => {
      [
        { a: t * 0.0009, color: accent },
        { a: t * 0.0009 + Math.PI * 0.95, color: ink },
      ].forEach(({ a, color }) => {
        if (back !== Math.sin(a) < 0) return;
        const p = ringPoint(a);
        if (back && p.x * p.x + p.y * p.y < r * r) return;
        ctx.fillStyle = `rgba(${color},${back ? 0.45 : 1})`;
        dot(ctx, cx + p.x * c - c * 0.7, cy + p.y * c - c * 0.7, c * 1.4);
      });
    };

    ringHalf(true);
    satellites(true);
    // The crescent: a glint travels along the lit edge; the surface shimmers faintly.
    const sweep = (t * 0.0006) % (Math.PI * 2);
    const x0 = Math.round(cx / c);
    const y0 = Math.round(cy / c);
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue;
        if ((x - r * 0.55) ** 2 + (y + r * 0.25) ** 2 <= (r * 0.92) ** 2) continue;
        const edge = x * x + y * y > (r - 1.5) ** 2;
        let alpha = edge ? 0.9 : 0.62 + 0.1 * Math.sin(t * 0.002 + x * 0.9 + y * 1.3);
        if (edge) {
          const d = Math.abs(((Math.atan2(y, x) - sweep + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (d < 0.45) alpha = 1;
        }
        ctx.fillStyle = `rgba(${ink},${alpha.toFixed(3)})`;
        dot(ctx, (x0 + x) * c, (y0 + y) * c, c);
      }
    }
    ringHalf(false);
    satellites(false);
  }
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private cell = 4;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
    this.resize();
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.round(rect.width);
    this.h = Math.round(rect.height);
    this.cell = this.w < 640 ? 3 : 4;
    const rand = seeded(7);
    // Fewer than before: the page-wide Starfield shows through the hero too.
    const count = Math.round((this.w * this.h) / 14000);
    this.stars = Array.from({ length: count }, () => ({
      x: Math.floor((rand() * this.w) / this.cell) * this.cell,
      y: Math.floor((rand() * this.h * 0.72) / this.cell) * this.cell,
      phase: rand() * Math.PI * 2,
      speed: 0.6 + rand() * 1.6,
      big: rand() < 0.07,
    }));
    this.planets = layoutPlanets(this.w, this.h);
    this.renderStatic();
  }

  /** Moon and mountains don't move: drawn once per resize. */
  private renderStatic(): void {
    const layer = document.createElement("canvas");
    const ctx = fitCanvas(layer, this.w, this.h);
    if (!ctx) return;
    const c = this.cell;
    // The moon is animated (see drawMoon); here only its place. Below 1100px the headline
    // spans the width, so the moon sits in the gap between the navbar and the headline; on
    // wide screens it stays clear of the 720px-wide headline.
    const narrow = this.w < 1100;
    this.moon = {
      x: narrow ? this.w * 0.86 : Math.max(this.w * 0.85, (this.w + 720) / 2 + 100),
      y: narrow ? 100 : Math.min(this.h * 0.2, 230),
      r: this.w < 640 ? 5 : narrow ? 6 : 10,
    };
    this.buildCity(ctx, c);
    this.staticLayer = layer;
  }

  /**
   * A pixel city along the bottom of the hero, in three layers drawn opaque so
   * nearer blocks hide farther ones: hazy towers at the back, moonlit buildings
   * (a lit face and a shadow face, rooftop details, windows) in the middle, and
   * dark low-rise in front, whose few lights twinkle (see draw()).
   */
  private buildCity(ctx: CanvasRenderingContext2D, c: number): void {
    const p = this.palette;
    const scale = this.w < 640 ? 0.62 : 1;
    const snap = (v: number) => Math.round(v / c) * c;
    this.lights = [];
    // Tones are a share of the way from the night sky to the ink: the back is hazy, the front
    // darkest, and edges catch the moonlight.
    const tones = [
      { body: 0.17, lit: 0.21, edge: 0.3 },
      { body: 0.1, lit: 0.16, edge: 0.34 },
      { body: 0.045, lit: 0.07, edge: 0.18 },
    ];
    const layers = [
      {
        seed: 31,
        minH: 90,
        maxH: 180,
        minW: 5,
        maxW: 11,
        ...tones[0]!,
        windows: 0.06,
        front: false,
      },
      {
        seed: 47,
        minH: 55,
        maxH: 135,
        minW: 7,
        maxW: 15,
        ...tones[1]!,
        windows: 0.2,
        front: false,
      },
      { seed: 59, minH: 22, maxH: 62, minW: 6, maxW: 13, ...tones[2]!, windows: 0.12, front: true },
    ];
    for (const L of layers) {
      const rand = seeded(L.seed);
      let x = -snap(rand() * 40);
      while (x < this.w) {
        const bw = Math.round(L.minW + rand() * (L.maxW - L.minW)) * c;
        const bh = snap((L.minH + rand() * (L.maxH - L.minH)) * scale);
        const top = this.h - bh;
        const litW = snap(bw * (0.3 + rand() * 0.2));
        // Body: shadow face, then the moonlit face on the left.
        ctx.fillStyle = mix(p, L.body);
        ctx.fillRect(x, top, bw, bh);
        ctx.fillStyle = mix(p, L.lit);
        ctx.fillRect(x, top, litW, bh);
        // Rooftop: a setback, an antenna, a water tank or a spire.
        const roof = rand();
        ctx.fillStyle = mix(p, L.lit);
        if (roof < 0.22 && bw > 6 * c) {
          const sw = snap(bw * 0.5);
          const sh = snap(c * (3 + rand() * 4));
          ctx.fillRect(x + snap((bw - sw) / 2), top - sh, sw, sh);
        } else if (roof < 0.42) {
          ctx.fillStyle = mix(p, L.edge);
          ctx.fillRect(
            x + snap(bw * (0.2 + rand() * 0.6)),
            top - c * (3 + Math.floor(rand() * 4)),
            Math.max(1, c / 2),
            c * 6,
          );
        } else if (roof < 0.55 && bw > 5 * c) {
          const tx = x + snap(bw * 0.6);
          ctx.fillRect(tx, top - 3 * c, 2 * c, 2 * c);
          ctx.fillRect(tx, top - c, Math.max(1, c / 2), c);
          ctx.fillRect(tx + 2 * c - Math.max(1, c / 2), top - c, Math.max(1, c / 2), c);
        } else if (roof < 0.62 && !L.front) {
          const mid = x + snap(bw / 2) - c;
          ctx.fillRect(mid, top - 4 * c, 2 * c, 4 * c);
          ctx.fillStyle = mix(p, L.edge);
          ctx.fillRect(mid + c / 2, top - 8 * c, Math.max(1, c / 2), 4 * c);
        }
        // Roofline and lit edge catch the moonlight.
        ctx.fillStyle = mix(p, L.edge);
        ctx.fillRect(x, top, bw, Math.max(1, c / 2));
        ctx.fillRect(x, top, Math.max(1, c / 2), bh);
        // Windows: a grid, some lit. The front layer's lit windows twinkle in draw().
        for (let wy = top + 2 * c; wy < this.h - 2 * c; wy += 2 * c) {
          for (let wx = x + c; wx <= x + bw - 2 * c; wx += 2 * c) {
            const r = rand();
            if (r < L.windows) {
              const pink = rand() < 0.07;
              if (L.front) this.lights.push({ x: wx, y: wy, phase: rand() * 30, pink });
              else {
                ctx.fillStyle = pink
                  ? `rgba(${p.accent},0.85)`
                  : mix(p, L.front ? 0.7 : 0.45 + rand() * 0.25);
                ctx.fillRect(wx, wy, c - 1, c - 1);
              }
            } else if (r < L.windows + 0.25) {
              // Unlit windows give the facades texture.
              ctx.fillStyle = mix(p, L.body + 0.03);
              ctx.fillRect(wx, wy, c - 1, c - 1);
            }
          }
        }
        x += bw + (L.front ? 0 : c * Math.floor(rand() * 2));
      }
    }
    // A street line along the very bottom.
    ctx.fillStyle = mix(p, 0.2);
    ctx.fillRect(0, this.h - Math.max(1, c / 2), this.w, Math.max(1, c / 2));
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { ink } = this.palette;
    const c = this.cell;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.stars) {
      const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(time * 0.001 * s.speed + s.phase));
      ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
      ctx.fillRect(s.x, s.y, c - 1, c - 1);
      if (s.big && a > 0.6) {
        ctx.fillRect(s.x - c, s.y, c - 1, c - 1);
        ctx.fillRect(s.x + c, s.y, c - 1, c - 1);
        ctx.fillRect(s.x, s.y - c, c - 1, c - 1);
        ctx.fillRect(s.x, s.y + c, c - 1, c - 1);
      }
    }
    // Clouds drift slowly and wrap; drawn as dashes, like a dot-matrix display.
    CLOUDS.forEach((shape, i) => {
      const span = this.w + shape[0]!.length * c * 2;
      const x0 = ((time * 0.006 * (i + 1) + i * span * 0.37) % span) - shape[0]!.length * c;
      const y0 = Math.round((this.h * (0.12 + i * 0.17)) / c) * c;
      ctx.fillStyle = `rgba(${ink},0.28)`;
      shape.forEach((row, ry) =>
        [...row].forEach((ch, rx) => {
          if (ch === "x" && rx % 2 === 0)
            ctx.fillRect(Math.round(x0 + rx * c), y0 + ry * c, c * 1.5, 1.5);
        }),
      );
    });
    // Planets sit behind the moon and the city.
    for (const p of this.planets) drawPlanet(ctx, p, time, this.palette, c);
    this.drawMoon(ctx, time);
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0, this.w, this.h);
    // Lights in the front buildings switch on and off now and then.
    for (const l of this.lights) {
      if (Math.sin(time * 0.0005 + l.phase) < -0.55) continue;
      ctx.fillStyle = l.pink ? `rgba(${this.palette.accent},0.9)` : mix(this.palette, 0.75);
      ctx.fillRect(l.x, l.y, c - 1, c - 1);
    }
  }
}

/** A city skyline with windows that switch on and off. */
export class Skyline {
  private ctx: CanvasRenderingContext2D | null = null;
  private windows: Array<{ x: number; y: number; phase: number; pink: boolean }> = [];
  private base: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
    this.resize();
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.round(rect.width);
    this.h = Math.round(rect.height);
    const c = 4;
    const rand = seeded(5);
    const layer = document.createElement("canvas");
    const ctx = fitCanvas(layer, this.w, this.h);
    if (!ctx) return;
    this.windows = [];
    let x = 0;
    while (x < this.w) {
      const bw = (4 + Math.floor(rand() * 7)) * c;
      const bh = Math.round((this.h * (0.25 + rand() * 0.6)) / c) * c;
      const top = this.h - bh;
      ctx.fillStyle = `rgba(${this.palette.ink},0.16)`;
      ctx.fillRect(x, top, bw - c, bh);
      if (rand() < 0.25) ctx.fillRect(x + Math.floor(bw / 2) - c, top - 3 * c, c, 3 * c);
      for (let wy = top + 2 * c; wy < this.h - 2 * c; wy += 2 * c) {
        for (let wx = x + c; wx < x + bw - 2 * c; wx += 2 * c) {
          if (rand() < 0.4)
            this.windows.push({ x: wx, y: wy, phase: rand() * 40, pink: rand() < 0.08 });
        }
      }
      x += bw;
    }
    this.base = layer;
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.base) ctx.drawImage(this.base, 0, 0, this.w, this.h);
    for (const w of this.windows) {
      const on = Math.sin(time * 0.0004 + w.phase) > -0.3;
      if (!on) continue;
      ctx.fillStyle = w.pink ? `rgba(${this.palette.accent},0.9)` : `rgba(${this.palette.ink},0.6)`;
      ctx.fillRect(w.x, w.y, 3, 3);
    }
  }
}

/*
 * Feature illustrations: '#' ink, '+' accent, ':' faint ink, '.' empty.
 */
export const ILLUSTRATIONS: Record<string, string[]> = {
  chart: [
    "............................",
    ".:..................+++.....",
    ".:.................+..+.....",
    ".:........###.....+....+....",
    ".:.......#...#...+......+...",
    ".:..##..#.....###.......+...",
    ".:.#..##....................",
    ".:#.....................#...",
    ".:..................##..#...",
    ".:.......##.........##..#...",
    ".:.......##....##...##..#...",
    ".:..##...##....##...##..#...",
    ".:..##...##....++...##..#...",
    ".:..##...##....++...##..#...",
    ".:..##...##....++...##..#...",
    ".::::::::::::::::::::::::::.",
  ],
  study: [
    "............................",
    "...........++++++++++++.....",
    "...........+..........+.....",
    "...........+..###.....+.....",
    "...........+..........+.....",
    "...........+..#####...+.....",
    "...........++++++++++++.....",
    "............................",
    "..#########....#########....",
    ".#.........#..#.........#...",
    ".#.:::::::.#..#.:::::::.#...",
    ".#.........#..#.........#...",
    ".#.:::::::.#..#.:::::::.#...",
    ".#.........#..#.........#...",
    "..##########::##########....",
    "............................",
  ],
  dev: [
    "............................",
    "........#####...............",
    ".......#.....#..............",
    "......#..+++..#.............",
    "......#.+...+.#.............",
    "......#.+...+.#.............",
    "......#..+++..#.............",
    ".......#..+..#..............",
    "........#...#...##########..",
    ".........###....#........#..",
    "................#.+.......#.",
    "................#..+......#.",
    "................#.+..###..#.",
    "................#........#..",
    "................##########..",
    "............................",
  ],
  cli: [
    "............................",
    "..######################....",
    "..#.+.+.+..............#....",
    "..######################....",
    "..#....................#....",
    "..#.+..................#....",
    "..#..+..#####..........#....",
    "..#.+..................#....",
    "..#....................#....",
    "..#.:::::::::..........#....",
    "..#.::::::.............#....",
    "..#....................#....",
    "..#.+..++..............#....",
    "..#....................#....",
    "..######################....",
    "............................",
  ],
};

/** The pixel pointer that travels down the features timeline. */
export const CURSOR = [
  "+.....",
  "++....",
  "+++...",
  "++++..",
  "+++++.",
  "+++...",
  "+.++..",
  "...++.",
];

export function drawPixels(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  cell: number,
  palette: Palette,
  dots = true,
): void {
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle =
        ch === "+"
          ? `rgba(${palette.accent},1)`
          : ch === ":"
            ? `rgba(${palette.ink},0.35)`
            : `rgba(${palette.ink},0.85)`;
      if (dots) dot(ctx, x * cell, y * cell, cell);
      else ctx.fillRect(x * cell, y * cell, cell, cell);
    }),
  );
}

interface FieldStar {
  x: number;
  y: number;
  depth: number;
  phase: number;
  speed: number;
  big: boolean;
}

interface Meteor {
  x: number;
  y: number;
  born: number;
}

interface Mote {
  x: number;
  y: number;
  drift: number;
  phase: number;
}

/**
 * The page-wide background: twinkling stars in two depths (they shift a little
 * as you scroll), an occasional shooting star, and a few pink motes rising.
 * A fixed canvas the size of the viewport.
 */
export class Starfield {
  private ctx: CanvasRenderingContext2D | null = null;
  private stars: FieldStar[] = [];
  private motes: Mote[] = [];
  private meteor: Meteor | null = null;
  private nextMeteor = 0;
  private w = 0;
  private h = 0;
  private readonly rand = seeded(99);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    this.w = Math.round(this.canvas.getBoundingClientRect().width);
    this.h = Math.round(this.canvas.getBoundingClientRect().height);
    const rand = seeded(17);
    const count = Math.round((this.w * this.h) / 6500);
    this.stars = Array.from({ length: count }, () => ({
      x: rand() * this.w,
      y: rand() * this.h,
      depth: rand() < 0.7 ? 0.04 : 0.1,
      phase: rand() * Math.PI * 2,
      speed: 0.5 + rand() * 1.5,
      big: rand() < 0.06,
    }));
    this.motes = Array.from({ length: Math.round(this.w / 110) }, () => ({
      x: rand() * this.w,
      y: rand() * this.h,
      drift: 0.008 + rand() * 0.012,
      phase: rand() * Math.PI * 2,
    }));
  }

  draw(time: number, scrollY: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { ink, accent } = this.palette;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.stars) {
      // Parallax: far stars move less than near ones.
      const y = (((s.y - scrollY * s.depth) % this.h) + this.h) % this.h;
      const a = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.001 * s.speed + s.phase));
      ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
      const x = Math.round(s.x);
      const yy = Math.round(y);
      ctx.fillRect(x, yy, 2, 2);
      if (s.big && a > 0.5) {
        ctx.fillRect(x - 3, yy, 2, 2);
        ctx.fillRect(x + 3, yy, 2, 2);
        ctx.fillRect(x, yy - 3, 2, 2);
        ctx.fillRect(x, yy + 3, 2, 2);
      }
    }
    // Pink motes rise slowly and wrap around.
    for (const m of this.motes) {
      const y = (((m.y - time * m.drift - scrollY * 0.06) % this.h) + this.h) % this.h;
      const x = m.x + Math.sin(time * 0.0007 + m.phase) * 10;
      const a = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(time * 0.002 + m.phase));
      ctx.fillStyle = `rgba(${accent},${a.toFixed(3)})`;
      ctx.fillRect(Math.round(x), Math.round(y), 3, 3);
    }
    // A shooting star every 5–11 seconds: a dotted streak that fades.
    if (!this.meteor && time > this.nextMeteor) {
      this.meteor = {
        x: this.rand() * this.w * 0.8 + this.w * 0.1,
        y: this.rand() * this.h * 0.5,
        born: time,
      };
    }
    if (this.meteor) {
      const age = (time - this.meteor.born) / 900;
      if (age >= 1) {
        this.meteor = null;
        this.nextMeteor = time + 5000 + this.rand() * 6000;
      } else {
        const headX = this.meteor.x - age * 260;
        const headY = this.meteor.y + age * 130;
        for (let i = 0; i < 10; i++) {
          const a = (1 - age) * (1 - i / 10) * 0.9;
          ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
          ctx.fillRect(Math.round(headX + i * 6), Math.round(headY - i * 3), 2, 2);
        }
      }
    }
  }
}

/**
 * A feature illustration that draws itself dot by dot (diagonal sweep) the
 * first time it's seen, then lets its pink dots shimmer.
 */
export class PixelIllustration {
  private ctx: CanvasRenderingContext2D | null = null;
  private cell = 6;
  private revealStart = -1;
  private readonly cells: Array<{ x: number; y: number; ch: string; order: number }>;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly rows: string[],
    private palette: Palette,
    private readonly animate: boolean,
  ) {
    const maxOrder = rows.length + rows[0]!.length;
    this.cells = rows.flatMap((row, y) =>
      [...row].flatMap((ch, x) => (ch === "." ? [] : [{ x, y, ch, order: (x + y) / maxOrder }])),
    );
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(): void {
    const width = this.canvas.parentElement!.clientWidth - 32;
    this.cell = Math.min(9, Math.max(4, Math.floor(width / this.rows[0]!.length)));
    this.ctx = fitCanvas(
      this.canvas,
      this.rows[0]!.length * this.cell,
      this.rows.length * this.cell,
    );
  }

  /** Starts the reveal the first time the illustration is on screen. */
  start(time: number): void {
    if (this.revealStart < 0) this.revealStart = time;
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const c = this.cell;
    const { ink, accent } = this.palette;
    const progress = !this.animate
      ? 1
      : this.revealStart < 0
        ? 0
        : Math.min(1, (time - this.revealStart) / 1100);
    ctx.clearRect(0, 0, this.rows[0]!.length * c, this.rows.length * c);
    for (const cell of this.cells) {
      if (cell.order > progress * 1.05) continue;
      let alpha = cell.ch === ":" ? 0.35 : 0.85;
      // The newest dots flash bright as the sweep passes.
      if (progress < 1 && progress * 1.05 - cell.order < 0.06) alpha = 1;
      if (cell.ch === "+") {
        const shimmer =
          this.animate && progress >= 1
            ? 0.65 + 0.35 * Math.sin(time * 0.004 + cell.x * 0.7 + cell.y)
            : 1;
        ctx.fillStyle = `rgba(${accent},${shimmer.toFixed(3)})`;
      } else {
        ctx.fillStyle = `rgba(${ink},${alpha})`;
      }
      dot(ctx, cell.x * c, cell.y * c, c);
    }
  }
}

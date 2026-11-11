/**
 * Shared by the landing and docs pages: theme toggle, the page-wide starfield,
 * copy buttons, mascot sprites, illustrations, reveal-on-scroll and the single
 * animation loop that only runs for things on screen.
 */
import {
  buildMascotGrid,
  drawGrid,
  MASCOT_H,
  MASCOT_W,
  type MascotState,
} from "../shared/sprite.js";
import {
  fitCanvas,
  ILLUSTRATIONS,
  PixelIllustration,
  readPalette,
  Starfield,
  type Palette,
} from "./art.js";

export const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string) => [
  ...document.querySelectorAll<T>(sel),
];
export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// --- Theme ------------------------------------------------------------------------
const THEME_KEY = "mofu.landingTheme";
const themeListeners: Array<(p: Palette) => void> = [];
export const onThemeChange = (fn: (p: Palette) => void) => themeListeners.push(fn);

function currentTheme(): "dark" | "light" {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: "dark" | "light" | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const toggle = $<HTMLButtonElement>("#theme-toggle");
  const now = currentTheme();
  toggle?.setAttribute(
    "aria-label",
    now === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
  toggle?.setAttribute("aria-pressed", String(now === "light"));
  const palette = readPalette();
  themeListeners.forEach((fn) => fn(palette));
}

// --- Animation loop: one rAF for everything visible --------------------------------
interface Animated {
  root: Element;
  visible: boolean;
  frame: (t: number) => void;
  onShow?: (t: number) => void;
}
const animated: Animated[] = [];
let running = false;

function loop(t: number): void {
  const active = animated.filter((a) => a.visible);
  if (!active.length || document.hidden || reducedMotion.matches) {
    running = false;
    return;
  }
  active.forEach((a) => a.frame(t));
  requestAnimationFrame(loop);
}

export function startLoop(): void {
  if (running || reducedMotion.matches) return;
  running = true;
  requestAnimationFrame(loop);
}

const visibility = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const a = animated.find((x) => x.root === entry.target);
    if (!a) continue;
    a.visible = entry.isIntersecting;
    if (a.visible) a.onShow?.(performance.now());
  }
  startLoop();
});

/** Runs `frame` every animation frame while `root` is on screen (never with reduced motion). */
export function animate(
  root: Element,
  frame: (t: number) => void,
  onShow?: (t: number) => void,
): void {
  animated.push({ root, visible: false, frame, ...(onShow && { onShow }) });
  visibility.observe(root);
}

// --- Static sprites ------------------------------------------------------------------
function drawMascots(): void {
  for (const c of $$<HTMLCanvasElement>("canvas[data-mascot]")) {
    const px = Number(c.dataset.px ?? 3);
    const ctx = fitCanvas(c, MASCOT_W * px, MASCOT_H * px);
    if (ctx)
      drawGrid(ctx, buildMascotGrid((c.dataset.mascot as MascotState) || "ready"), {
        px,
        dots: c.dataset.dots === "true",
      });
  }
}

export interface PageHooks {
  /** Called after layout changes (resize, theme) so pages can redraw their own canvases. */
  redraw?: (palette: Palette) => void;
}

export function initCommon(hooks: PageHooks = {}): void {
  // Theme.
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
  } catch {
    // Storage blocked: follow the system theme.
  }
  $("#theme-toggle")?.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered; fine.
    }
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) applyTheme(null);
  });

  // Copy buttons.
  for (const button of $$<HTMLButtonElement>("[data-copy]")) {
    button.addEventListener("click", async () => {
      const status = button.parentElement?.querySelector<HTMLElement>(".copy-status");
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
        if (status) status.textContent = "Copied!";
        button.classList.add("copied");
      } catch {
        if (status) status.textContent = "Press Ctrl+C to copy";
      }
      window.setTimeout(() => {
        if (status) status.textContent = "";
        button.classList.remove("copied");
      }, 1800);
    });
  }

  // Page-wide starfield.
  const fieldCanvas = $<HTMLCanvasElement>("#starfield");
  const field = fieldCanvas ? new Starfield(fieldCanvas, readPalette()) : null;
  if (field && fieldCanvas) {
    // Background only: 30 fps is plenty, and it starts after the page has loaded.
    let last = 0;
    const begin = () =>
      animate(fieldCanvas, (t) => {
        if (t - last < 33) return;
        last = t;
        field.draw(t, window.scrollY);
      });
    if (document.readyState === "complete") window.setTimeout(begin, 300);
    else window.addEventListener("load", () => window.setTimeout(begin, 300), { once: true });
  }

  // Illustrations that draw themselves when they come into view.
  const illustrations: PixelIllustration[] = [];
  for (const c of $$<HTMLCanvasElement>("canvas[data-illustration]")) {
    const rows = ILLUSTRATIONS[c.dataset.illustration ?? ""];
    if (!rows) continue;
    const art = new PixelIllustration(c, rows, readPalette(), !reducedMotion.matches);
    illustrations.push(art);
    animate(
      c,
      (t) => art.draw(t),
      (t) => art.start(t),
    );
  }

  const redrawAll = () => {
    const palette = readPalette();
    field?.setPalette(palette);
    field?.resize();
    field?.draw(performance.now(), window.scrollY);
    for (const art of illustrations) {
      art.setPalette(palette);
      art.resize();
      art.draw(performance.now());
    }
    drawMascots();
    hooks.redraw?.(palette);
  };
  onThemeChange(redrawAll);

  // Reveal sections as they scroll into view (content is visible without JS or with reduced motion).
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("revealed");
        reveal.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  $$("[data-reveal]").forEach((el) => reveal.observe(el));
  document.documentElement.classList.add("js");

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(redrawAll, 150);
  });
  document.addEventListener("visibilitychange", startLoop);
  reducedMotion.addEventListener("change", () => {
    document.documentElement.classList.toggle("reduced-motion", reducedMotion.matches);
    startLoop();
  });
  document.documentElement.classList.toggle("reduced-motion", reducedMotion.matches);

  applyTheme((document.documentElement.dataset.theme as "dark" | "light" | undefined) ?? null);

  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());
}

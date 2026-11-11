import "./landing.css";
import {
  buildMascotGrid,
  drawGrid,
  MASCOT_H,
  MASCOT_W,
  type MascotState,
} from "../shared/sprite.js";
import {
  CURSOR,
  drawPixels,
  fitCanvas,
  ILLUSTRATIONS,
  NightSky,
  readPalette,
  Skyline,
} from "./art.js";
import { Demo, type DemoElements } from "./demo.js";

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// --- Theme ------------------------------------------------------------------
const THEME_KEY = "mofu.landingTheme";
const themeListeners: Array<() => void> = [];

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
  themeListeners.forEach((fn) => fn());
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") applyTheme(saved);
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
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => applyTheme(null));
applyTheme((document.documentElement.dataset.theme as "dark" | "light" | undefined) ?? null);

// --- Copy `npx mofu` ----------------------------------------------------------
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

// --- Static sprites -------------------------------------------------------------
function drawMascot(canvas: HTMLCanvasElement, state: MascotState, px: number, dots = false): void {
  const ctx = fitCanvas(canvas, MASCOT_W * px, MASCOT_H * px);
  if (ctx) drawGrid(ctx, buildMascotGrid(state), { px, dots });
}

function drawStatic(): void {
  const palette = readPalette();
  for (const c of $$<HTMLCanvasElement>("canvas[data-mascot]")) {
    drawMascot(
      c,
      (c.dataset.mascot as MascotState) || "ready",
      Number(c.dataset.px ?? 3),
      c.dataset.dots === "true",
    );
  }
  for (const c of $$<HTMLCanvasElement>("canvas[data-illustration]")) {
    const rows = ILLUSTRATIONS[c.dataset.illustration ?? ""];
    if (!rows) continue;
    const cell = Math.min(
      9,
      Math.max(4, Math.floor((c.parentElement!.clientWidth - 32) / rows[0]!.length)),
    );
    const ctx = fitCanvas(c, rows[0]!.length * cell, rows.length * cell);
    if (ctx) drawPixels(ctx, rows, cell, palette);
  }
  const cursor = $<HTMLCanvasElement>("#timeline-cursor");
  if (cursor) {
    const ctx = fitCanvas(cursor, CURSOR[0]!.length * 3, CURSOR.length * 3);
    if (ctx) drawPixels(ctx, CURSOR, 3, palette, false);
  }
}

// --- Animated scenes ----------------------------------------------------------------
interface Animated {
  root: Element;
  visible: boolean;
  frame: (t: number) => void;
}
const animated: Animated[] = [];

const skyCanvas = $<HTMLCanvasElement>("#sky");
const sky = skyCanvas ? new NightSky(skyCanvas, readPalette()) : null;
const skylineCanvas = $<HTMLCanvasElement>("#skyline");
const skyline = skylineCanvas ? new Skyline(skylineCanvas, readPalette()) : null;

const demoRoot = $("#demo");
const demo = demoRoot
  ? new Demo(
      {
        root: demoRoot,
        mascot: $<HTMLCanvasElement>("#demo-mascot")!,
        led: $("#demo-led")!,
        file: $("#demo-file")!,
        typed: $("#demo-typed")!,
        visual: $("#demo-visual")!,
        result: $("#demo-result")!,
        detail: $("#demo-detail")!,
        tabs: $$<HTMLButtonElement>("#demo-tabs button"),
      } satisfies DemoElements,
      !reducedMotion.matches,
    )
  : null;

if (sky && skyCanvas) animated.push({ root: skyCanvas, visible: true, frame: (t) => sky.draw(t) });
if (skyline && skylineCanvas)
  animated.push({ root: skylineCanvas, visible: false, frame: (t) => skyline.draw(t) });
if (demo && demoRoot) animated.push({ root: demoRoot, visible: true, frame: (t) => demo.frame(t) });

function resizeAll(): void {
  sky?.resize();
  skyline?.resize();
  drawStatic();
  // One still frame so nothing is blank when animation is off or paused.
  const t = performance.now();
  sky?.draw(t);
  skyline?.draw(t);
}

themeListeners.push(() => {
  const p = readPalette();
  sky?.setPalette(p);
  skyline?.setPalette(p);
  drawStatic();
  sky?.draw(performance.now());
  skyline?.draw(performance.now());
});

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
function startLoop(): void {
  if (running || reducedMotion.matches) return;
  running = true;
  requestAnimationFrame(loop);
}

// Pause whatever is off screen.
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const a = animated.find((x) => x.root === entry.target);
    if (a) a.visible = entry.isIntersecting;
  }
  startLoop();
});
animated.forEach((a) => observer.observe(a.root));
document.addEventListener("visibilitychange", startLoop);

function applyMotion(): void {
  document.documentElement.classList.toggle("reduced-motion", reducedMotion.matches);
  if (reducedMotion.matches) demo?.renderStatic();
  else startLoop();
}
reducedMotion.addEventListener("change", applyMotion);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resizeAll, 150);
});

resizeAll();
applyMotion();

// --- Features timeline: the pointer follows your scroll -----------------------------
const timeline = $("#timeline");
const cursorEl = $("#timeline-cursor");
function placeCursor(): void {
  if (!timeline || !cursorEl) return;
  const rect = timeline.getBoundingClientRect();
  const travel = Math.max(0, rect.height - cursorEl.offsetHeight);
  const progress = Math.min(
    1,
    Math.max(0, (window.innerHeight * 0.55 - rect.top) / Math.max(1, rect.height)),
  );
  cursorEl.style.transform = `translateY(${Math.round(progress * travel)}px)`;
  $$("#timeline .feature").forEach((f) => {
    const r = f.getBoundingClientRect();
    f.classList.toggle(
      "is-active",
      r.top < window.innerHeight * 0.6 && r.bottom > window.innerHeight * 0.3,
    );
  });
}
let ticking = false;
window.addEventListener(
  "scroll",
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      placeCursor();
      ticking = false;
    });
  },
  { passive: true },
);
placeCursor();

// Footer year.
const year = $("#year");
if (year) year.textContent = String(new Date().getFullYear());

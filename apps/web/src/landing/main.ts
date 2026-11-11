import "./landing.css";
import {
  CURSOR,
  drawPixels,
  fitCanvas,
  NightSky,
  readPalette,
  Skyline,
  type Palette,
} from "./art.js";
import { $, $$, animate, initCommon, reducedMotion } from "./common.js";
import { Demo, type DemoElements } from "./demo.js";

// --- Hero sky, closing skyline and the demo card -----------------------------------
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

if (sky && skyCanvas) animate(skyCanvas, (t) => sky.draw(t));
if (skyline && skylineCanvas) animate(skylineCanvas, (t) => skyline.draw(t));
if (demo && demoRoot) animate(demoRoot, (t) => demo.frame(t));

function drawCursor(palette: Palette): void {
  const cursor = $<HTMLCanvasElement>("#timeline-cursor");
  const ctx = cursor && fitCanvas(cursor, CURSOR[0]!.length * 3, CURSOR.length * 3);
  if (ctx) drawPixels(ctx, CURSOR, 3, palette, false);
}

function redraw(palette: Palette): void {
  sky?.setPalette(palette);
  skyline?.setPalette(palette);
  drawCursor(palette);
  sky?.draw(performance.now());
  skyline?.draw(performance.now());
}

initCommon({ redraw });
if (reducedMotion.matches) demo?.renderStatic();
reducedMotion.addEventListener("change", () => reducedMotion.matches && demo?.renderStatic());

// --- Features timeline: the pointer follows your scroll and fills the rail ------------
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
  const y = Math.round(progress * travel);
  cursorEl.style.transform = `translateY(${y}px)`;
  timeline.style.setProperty("--fill", `${y + 8}px`);
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

// --- The terminal types its session out when it scrolls into view ----------------------
const pre = $("#cli .terminal pre");
if (pre) {
  const lines = pre.innerHTML.split("\n");
  pre.innerHTML = lines.map((l) => `<span class="t-line">${l || " "}</span>`).join("");
  const spans = $$("#cli .t-line");
  if (reducedMotion.matches) spans.forEach((s) => s.classList.add("shown"));
  else {
    const typer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        typer.disconnect();
        spans.forEach((s, i) => window.setTimeout(() => s.classList.add("shown"), 120 + i * 170));
      },
      { threshold: 0.4 },
    );
    typer.observe(pre);
  }
}

/**
 * The hero demo card: type → work → result, cycling through three scenarios.
 * Pure timing logic is exported for tests; the DOM side is driven by rAF and
 * only runs while the card is on screen.
 */
import { buildPeekGrid, drawGrid, MASCOT_W, type MascotState } from "../shared/sprite.js";
import { fitCanvas } from "./art.js";

export interface Scenario {
  id: "data" | "dev" | "study";
  label: string;
  file: string;
  prompt: string;
  badge: string;
  result: string;
  detail: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "data",
    label: "Data",
    file: "sales.csv · 2,431 rows",
    prompt: "Why did revenue drop in March?",
    badge: "ANALYZING",
    result: "March revenue dropped 18%",
    detail: "Mostly in two regions. Public holidays explain about a third of it.",
  },
  {
    id: "dev",
    label: "Dev",
    file: "package.json · 214 packages",
    prompt: "Is anything vulnerable?",
    badge: "SCANNING",
    result: "3 vulnerable packages, 1 critical",
    detail: "minimist 1.2.5 is critical; it's fixed in 1.2.6.",
  },
  {
    id: "study",
    label: "Study",
    file: "chapter-3.pdf · 24 pages",
    prompt: "Make flashcards for Friday's quiz",
    badge: "STUDYING",
    result: "15 flashcards ready",
    detail: "Every card cites its page. Export to Anki anytime.",
  },
];

export const TIMING = { typing: 1800, working: 3200, result: 3400 };
export const SCENARIO_MS = TIMING.typing + TIMING.working + TIMING.result;

export type Phase = "typing" | "working" | "result";

/** Where a scenario is after `elapsed` ms: its phase and progress (0..1) within it. */
export function phaseAt(elapsed: number): { phase: Phase; progress: number } {
  const t = ((elapsed % SCENARIO_MS) + SCENARIO_MS) % SCENARIO_MS;
  if (t < TIMING.typing) return { phase: "typing", progress: t / TIMING.typing };
  if (t < TIMING.typing + TIMING.working)
    return { phase: "working", progress: (t - TIMING.typing) / TIMING.working };
  return { phase: "result", progress: (t - TIMING.typing - TIMING.working) / TIMING.result };
}

const MASCOT_FOR: Record<Phase, MascotState> = {
  typing: "ready",
  working: "focus",
  result: "found",
};

const BARS = [
  { month: "Jan", value: 0.72 },
  { month: "Feb", value: 0.8 },
  { month: "Mar", value: 0.62 },
  { month: "Apr", value: 0.84 },
  { month: "May", value: 0.9 },
  { month: "Jun", value: 0.95 },
];

const PACKAGES = [
  { name: "react 19.2.0", bad: "" },
  { name: "lodash 4.17.15", bad: "high" },
  { name: "minimist 1.2.5", bad: "critical" },
  { name: "express 5.1.0", bad: "" },
  { name: "axios 0.21.1", bad: "high" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface DemoElements {
  root: HTMLElement;
  mascot: HTMLCanvasElement;
  led: HTMLElement;
  file: HTMLElement;
  typed: HTMLElement;
  visual: HTMLElement;
  result: HTMLElement;
  detail: HTMLElement;
  tabs: HTMLButtonElement[];
}

export class Demo {
  private index = 0;
  private start = 0;
  private mascotState: MascotState | null = null;
  private built: Scenario["id"] | null = null;
  private lastPhase: Phase | null = null;

  constructor(
    private readonly ui: DemoElements,
    private readonly animate: boolean,
  ) {
    ui.tabs.forEach((tab, i) =>
      tab.addEventListener("click", () => {
        this.index = i;
        this.start = performance.now();
        this.built = null;
        if (!this.animate) this.renderStatic();
      }),
    );
    window.addEventListener("resize", () => this.drawMascot(this.mascotState ?? "ready", true));
  }

  /** Reduced motion: the finished result of the chosen scenario, no animation. */
  renderStatic(): void {
    const s = SCENARIOS[this.index]!;
    this.build(s);
    this.apply(s, "result", 1);
  }

  frame(now: number): void {
    if (!this.start) this.start = now;
    let elapsed = now - this.start;
    if (elapsed >= SCENARIO_MS) {
      this.index = (this.index + 1) % SCENARIOS.length;
      this.start = now;
      elapsed = 0;
    }
    const s = SCENARIOS[this.index]!;
    if (this.built !== s.id) this.build(s);
    const { phase, progress } = phaseAt(elapsed);
    this.apply(s, phase, progress);
  }

  private drawMascot(state: MascotState, force = false): void {
    if (this.mascotState === state && !force) return;
    this.mascotState = state;
    // Must match the sizes reserved in landing.css (.demo-mascot), which also sets the
    // negative margin that rests the paws on the card: (PAW_ROWS - 1) * px.
    const px = window.matchMedia("(max-width: 480px)").matches ? 4 : 5;
    const grid = buildPeekGrid(state);
    const ctx = fitCanvas(this.ui.mascot, MASCOT_W * px, grid.length * px);
    if (!ctx) return;
    ctx.clearRect(0, 0, MASCOT_W * px, grid.length * px);
    drawGrid(ctx, grid, { px });
  }

  private build(s: Scenario): void {
    this.built = s.id;
    this.lastPhase = null;
    const { visual, file, result, detail } = this.ui;
    this.ui.tabs.forEach((t, i) =>
      t.setAttribute("aria-pressed", String(SCENARIOS[i]!.id === s.id)),
    );
    file.textContent = s.file;
    result.textContent = "";
    detail.textContent = "";
    visual.replaceChildren();
    visual.dataset.kind = s.id;
    if (s.id === "data") {
      for (const b of BARS) {
        const col = el("span", "bar");
        const fill = el("i");
        fill.style.setProperty("--h", String(b.value));
        col.append(fill, el("b", undefined, b.month));
        visual.append(col);
      }
    } else if (s.id === "dev") {
      for (const p of PACKAGES) {
        const row = el("span", "pkg");
        row.append(el("code", undefined, p.name), el("em", "pkg-status", "·"));
        row.dataset.bad = p.bad;
        visual.append(row);
      }
    } else {
      const book = el("span", "book");
      for (let i = 0; i < 3; i++) book.append(el("i", "page"));
      const card = el("span", "flash");
      const inner = el("span", "flash-inner");
      inner.append(
        el("span", "flash-front", "Where do the light reactions happen?"),
        el("span", "flash-back", "In the thylakoid membranes · page 42"),
      );
      card.append(inner);
      visual.append(book, card);
    }
  }

  private apply(s: Scenario, phase: Phase, progress: number): void {
    const { led, typed, visual, result, detail } = this.ui;
    this.drawMascot(MASCOT_FOR[phase]);
    const chars =
      phase === "typing"
        ? Math.ceil(s.prompt.length * Math.min(1, progress * 1.15))
        : s.prompt.length;
    if (typed.textContent!.length !== chars) typed.textContent = s.prompt.slice(0, chars);
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      led.textContent = phase === "typing" ? "READY" : phase === "working" ? s.badge : "FOUND";
      led.dataset.phase = phase;
      visual.dataset.phase = phase;
      this.ui.root.dataset.phase = phase;
      result.textContent = phase === "result" ? s.result : "";
      detail.textContent = phase === "result" ? s.detail : "";
    }
    const work = phase === "typing" ? 0 : phase === "working" ? progress : 1;
    if (s.id === "data") {
      // Bars draw themselves left to right; March lights up with the result.
      [...visual.children].forEach((col, i) => {
        const grow = Math.max(0, Math.min(1, work * BARS.length - i * 0.8));
        (col as HTMLElement).style.setProperty("--grow", grow.toFixed(3));
        col.classList.toggle("hi", phase === "result" && i === 2);
      });
    } else if (s.id === "dev") {
      [...visual.children].forEach((row, i) => {
        const checked = work * PACKAGES.length > i + 0.5;
        const status = row.lastElementChild as HTMLElement;
        const bad = (row as HTMLElement).dataset.bad;
        const text = !checked ? "·" : bad ? bad : "ok";
        if (status.textContent !== text) status.textContent = text;
        row.classList.toggle("bad", checked && Boolean(bad));
      });
    }
  }
}

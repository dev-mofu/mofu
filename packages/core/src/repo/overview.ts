/**
 * Deterministic repository overview. Works on any file source (local disk in
 * the CLI, GitHub in the browser), so it has no Node.js dependencies.
 * The model gets this compact map instead of the whole repository.
 */

/** A read-only view of a repository. Paths are relative, with forward slashes. */
export interface RepoSnapshot {
  name?: string;
  files: string[];
  /** Returns file text, or null if missing or too large. */
  readFile(path: string): Promise<string | null>;
}

export interface TestCommand {
  command: string;
  framework: string;
  /** Why we picked it, e.g. "package.json scripts.test". */
  source: string;
}

export interface RepoOverview {
  name?: string;
  fileCount: number;
  languages: Array<{ language: string; files: number; share: number }>;
  packageManagers: string[];
  frameworks: string[];
  entryPoints: string[];
  test: TestCommand | null;
  scripts: Record<string, string>;
  configFiles: string[];
  tree: string;
  readme: string | null;
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  cpp: "C++",
  cc: "C++",
  c: "C",
  h: "C",
  swift: "Swift",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
  css: "CSS",
  scss: "CSS",
  html: "HTML",
  sql: "SQL",
  sh: "Shell",
  ps1: "PowerShell",
};

/** Lockfiles and manifests that identify a package manager. Order matters (first match wins per ecosystem). */
const PACKAGE_MANAGERS: Array<[file: string, name: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Pipfile.lock", "pipenv"],
  ["requirements.txt", "pip"],
  ["go.mod", "go modules"],
  ["Cargo.toml", "cargo"],
  ["pom.xml", "maven"],
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["composer.json", "composer"],
  ["Gemfile", "bundler"],
];

/** npm dependency name -> framework label. */
const JS_FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  "@angular/core": "Angular",
  "solid-js": "Solid",
  astro: "Astro",
  "@remix-run/react": "Remix",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  koa: "Koa",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  vite: "Vite",
  tailwindcss: "Tailwind CSS",
  prisma: "Prisma",
  "drizzle-orm": "Drizzle",
  wrangler: "Cloudflare Workers",
  ai: "Vercel AI SDK",
};

const PY_FRAMEWORKS: Record<string, string> = {
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  streamlit: "Streamlit",
  pandas: "pandas",
  numpy: "NumPy",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  "scikit-learn": "scikit-learn",
  sqlalchemy: "SQLAlchemy",
};

const CONFIG_PATTERNS = [
  /^tsconfig(\..+)?\.json$/,
  /^(\.eslintrc.*|eslint\.config\.[cm]?[jt]s)$/,
  /^(\.prettierrc.*|prettier\.config\.[cm]?[jt]s)$/,
  /^(vite|vitest|jest|webpack|rollup|next|nuxt|astro|svelte|tailwind)\.config\.[cm]?[jt]s$/,
  /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/,
  /^wrangler\.(toml|jsonc?)$/,
  /^(pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|pytest\.ini|Makefile|\.env\.example)$/,
  /^\.github\/workflows\/.+\.ya?ml$/,
];

const NPM_PLACEHOLDER_TEST = /no test specified/i;
const TREE_MAX_DEPTH = 3;
const TREE_MAX_LINES = 120;
const README_MAX_CHARS = 1_500;
const MAX_SCRIPTS = 15;
const MAX_ENTRY_POINTS = 10;

const has = (files: Set<string>, path: string) => files.has(path);
const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

async function readJson<T>(snap: RepoSnapshot, path: string): Promise<T | null> {
  const text = await snap.readFile(path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function detectLanguages(files: string[]): RepoOverview["languages"] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = LANGUAGES[ext(f)];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts.entries()]
    .map(([language, n]) => ({ language, files: n, share: Math.round((n / total) * 100) }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);
}

/** Text tree of directories (and top-level files), depth- and size-limited. */
export function buildTree(
  files: string[],
  maxDepth = TREE_MAX_DEPTH,
  maxLines = TREE_MAX_LINES,
): string {
  interface Node {
    children: Map<string, Node>;
    fileCount: number;
  }
  const root: Node = { children: new Map(), fileCount: 0 };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? "";
      let child = node.children.get(name);
      if (!child) {
        child = { children: new Map(), fileCount: 0 };
        node.children.set(name, child);
      }
      child.fileCount++;
      node = child;
    }
  }
  const lines: string[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...node.children.entries()].sort()) {
      if (lines.length >= maxLines) return;
      lines.push(`${prefix}${name}/ (${child.fileCount} files)`);
      if (depth < maxDepth) walk(child, `${prefix}  `, depth + 1);
    }
  };
  walk(root, "", 1);
  const topFiles = files.filter((f) => !f.includes("/")).sort();
  for (const f of topFiles) {
    if (lines.length >= maxLines) break;
    lines.push(f);
  }
  if (lines.length >= maxLines) lines.push("… (tree truncated)");
  return lines.join("\n");
}

/** Picks the command that runs the project's tests, without running anything. */
export async function detectTestCommand(snap: RepoSnapshot): Promise<TestCommand | null> {
  const files = new Set(snap.files);
  if (has(files, "package.json")) {
    const pkg = await readJson<PackageJson>(snap, "package.json");
    const pm = has(files, "pnpm-lock.yaml")
      ? "pnpm"
      : has(files, "yarn.lock")
        ? "yarn"
        : has(files, "bun.lockb") || has(files, "bun.lock")
          ? "bun"
          : "npm";
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const framework = deps.vitest
      ? "vitest"
      : deps.jest
        ? "jest"
        : deps.mocha
          ? "mocha"
          : deps["@playwright/test"]
            ? "playwright"
            : "unknown";
    const script = pkg?.scripts?.test;
    if (script && !NPM_PLACEHOLDER_TEST.test(script)) {
      return { command: `${pm} test`, framework, source: "package.json scripts.test" };
    }
    if (framework === "vitest")
      return { command: "npx vitest run", framework, source: "vitest dependency" };
    if (framework === "jest") return { command: "npx jest", framework, source: "jest dependency" };
  }
  const pyproject = has(files, "pyproject.toml") ? await snap.readFile("pyproject.toml") : null;
  const hasPytest =
    has(files, "pytest.ini") ||
    has(files, "conftest.py") ||
    (pyproject?.includes("[tool.pytest") ?? false) ||
    snap.files.some((f) => /(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$/.test(f));
  if (hasPytest) {
    const runner = has(files, "uv.lock")
      ? "uv run "
      : has(files, "poetry.lock")
        ? "poetry run "
        : "python -m ";
    return {
      command: `${runner}pytest`,
      framework: "pytest",
      source: "pytest configuration or test_*.py files",
    };
  }
  if (has(files, "go.mod"))
    return { command: "go test ./...", framework: "go test", source: "go.mod" };
  if (has(files, "Cargo.toml"))
    return { command: "cargo test", framework: "cargo test", source: "Cargo.toml" };
  return null;
}

function entryPointsFromPackage(pkg: PackageJson, files: Set<string>): string[] {
  const found: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== "string") return;
    const clean = p.replace(/^\.\//, "");
    if (!found.includes(clean)) found.push(clean);
  };
  add(pkg.main);
  add(pkg.module);
  if (typeof pkg.bin === "string") add(pkg.bin);
  else if (pkg.bin) Object.values(pkg.bin).forEach(add);
  if (typeof pkg.exports === "string") add(pkg.exports);
  // Point at sources too when the declared entry is build output.
  for (const candidate of [
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/main.tsx",
    "src/index.js",
    "index.js",
    "server.js",
    "app.js",
  ]) {
    if (files.has(candidate)) add(candidate);
  }
  return found;
}

const ENTRY_CANDIDATES = [
  /^main\.py$/,
  /^app\.py$/,
  /^manage\.py$/,
  /^[^/]+\/__main__\.py$/,
  /^src\/main\.rs$/,
  /^main\.go$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^index\.html$/,
];

/** Builds the overview. Reads only manifests and the README. */
export async function buildRepoOverview(snap: RepoSnapshot): Promise<RepoOverview> {
  const files = new Set(snap.files);
  const packageManagers = [
    ...new Set(PACKAGE_MANAGERS.filter(([f]) => files.has(f)).map(([, n]) => n)),
  ];

  const frameworks = new Set<string>();
  const entryPoints: string[] = [];
  let scripts: Record<string, string> = {};
  let name = snap.name;

  const pkg = files.has("package.json") ? await readJson<PackageJson>(snap, "package.json") : null;
  if (pkg) {
    name ??= pkg.name;
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const label = JS_FRAMEWORKS[dep];
      if (label) frameworks.add(label);
    }
    entryPoints.push(...entryPointsFromPackage(pkg, files));
    scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).slice(0, MAX_SCRIPTS));
  }

  const pyDeps = [
    (await (files.has("requirements.txt") ? snap.readFile("requirements.txt") : null)) ?? "",
    (await (files.has("pyproject.toml") ? snap.readFile("pyproject.toml") : null)) ?? "",
  ]
    .join("\n")
    .toLowerCase();
  for (const [dep, label] of Object.entries(PY_FRAMEWORKS)) {
    if (
      new RegExp(`(^|[\\s"'\\[,])${dep.replace(/[-.]/g, "[-_.]")}([\\s=<>~!;\\[,"']|$)`, "m").test(
        pyDeps,
      )
    ) {
      frameworks.add(label);
    }
  }

  for (const f of snap.files) {
    if (ENTRY_CANDIDATES.some((re) => re.test(f)) && !entryPoints.includes(f)) entryPoints.push(f);
  }

  const readmePath = snap.files.find((f) => /^readme(\.(md|rst|txt))?$/i.test(f));
  const readmeText = readmePath ? await snap.readFile(readmePath) : null;
  const readme = readmeText
    ? readmeText.length > README_MAX_CHARS
      ? `${readmeText.slice(0, README_MAX_CHARS)}…`
      : readmeText
    : null;

  return {
    ...(name && { name }),
    fileCount: snap.files.length,
    languages: detectLanguages(snap.files),
    packageManagers,
    frameworks: [...frameworks],
    entryPoints: entryPoints.slice(0, MAX_ENTRY_POINTS),
    test: await detectTestCommand(snap),
    scripts,
    configFiles: snap.files
      .filter((f) => CONFIG_PATTERNS.some((re) => re.test(f) || re.test(base(f))))
      .slice(0, 25),
    tree: buildTree(snap.files),
    readme,
  };
}

/** Compact Markdown for the model. */
export function formatOverview(o: RepoOverview): string {
  const lines = [`# Repository overview${o.name ? `: ${o.name}` : ""}`, `Files: ${o.fileCount}`];
  if (o.languages.length) {
    lines.push(`Languages: ${o.languages.map((l) => `${l.language} ${l.share}%`).join(", ")}`);
  }
  if (o.packageManagers.length) lines.push(`Package managers: ${o.packageManagers.join(", ")}`);
  if (o.frameworks.length) lines.push(`Frameworks and libraries: ${o.frameworks.join(", ")}`);
  if (o.entryPoints.length) lines.push(`Entry points: ${o.entryPoints.join(", ")}`);
  lines.push(
    o.test
      ? `Tests: \`${o.test.command}\` (${o.test.framework}, from ${o.test.source})`
      : "Tests: no test setup detected",
  );
  const scripts = Object.entries(o.scripts);
  if (scripts.length)
    lines.push(`Scripts: ${scripts.map(([k, v]) => `${k} = \`${v}\``).join("; ")}`);
  if (o.configFiles.length) lines.push(`Config files: ${o.configFiles.join(", ")}`);
  lines.push("", "## Folder tree", "```", o.tree || "(empty)", "```");
  if (o.readme) lines.push("", "## README (excerpt)", o.readme);
  return lines.join("\n");
}

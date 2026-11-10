import semver from "semver";
import { normalizeName, type Dependency, type Ecosystem, type ParseResult } from "./types.js";

/** Files the scanner understands. */
export const MANIFEST_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|requirements[\w.-]*\.txt|pyproject\.toml)$/;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Specs that point outside the registry: nothing to look up on OSV by version. */
const NON_REGISTRY =
  /^(workspace:|file:|link:|portal:|git(\+|:)|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/;

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function dep(
  ecosystem: Ecosystem,
  name: string,
  version: string | null,
  declared: string,
  direct: boolean,
  resolved: boolean,
  file: string,
): Dependency {
  return { ecosystem, name, version, declared, direct, resolved, files: [file] };
}

/** Direct npm dependencies with their declared ranges. */
export function parsePackageJson(text: string, file: string): ParseResult {
  const notes: string[] = [];
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(text) as PackageJson;
  } catch {
    return { dependencies: [], notes: [`${file}: not valid JSON, skipped.`] };
  }
  const dependencies: Dependency[] = [];
  const all = { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies };
  for (const [name, spec] of Object.entries(all)) {
    if (typeof spec !== "string") continue;
    if (NON_REGISTRY.test(spec.trim())) {
      notes.push(`${file}: ${name} comes from "${spec}" (not the npm registry), skipped.`);
      continue;
    }
    const exact = semver.valid(spec.trim());
    // Without a lockfile, the lowest version the range allows is the safest guess.
    const lowest = exact ?? semver.minVersion(spec.trim())?.version ?? null;
    dependencies.push(dep("npm", name, lowest, spec, true, Boolean(exact), file));
  }
  return { dependencies, notes };
}

interface LockEntry {
  version?: string;
  link?: boolean;
  resolved?: string;
  dev?: boolean;
}

/** Every installed npm package from a lockfile (v2 or v3). */
export function parsePackageLock(text: string, file: string): ParseResult {
  let lock: { lockfileVersion?: number; packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return { dependencies: [], notes: [`${file}: not valid JSON, skipped.`] };
  }
  if (!lock.packages) {
    return {
      dependencies: [],
      notes: [
        `${file}: lockfile version ${lock.lockfileVersion ?? 1} isn't supported (needs v2 or v3, npm 7+). Run \`npm install\` with a current npm to upgrade it.`,
      ],
    };
  }
  const notes: string[] = [];
  const dependencies: Dependency[] = [];
  const root = lock.packages[""] as PackageJson | undefined;
  const directNames = new Set(
    Object.keys({ ...root?.dependencies, ...root?.devDependencies, ...root?.optionalDependencies }),
  );
  let links = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/")) continue; // root and workspace folders
    if (entry.link) {
      links++;
      continue;
    }
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!entry.version || !semver.valid(entry.version)) continue;
    const topLevel = path === `node_modules/${name}`;
    dependencies.push(
      dep("npm", name, entry.version, "", topLevel && directNames.has(name), true, file),
    );
  }
  if (links > 0)
    notes.push(`${file}: ${links} workspace package link(s) skipped (they're your own code).`);
  return { dependencies, notes };
}

/** One PEP 508 requirement: name[extras] (spec) ; marker */
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(\(?[^;]*?\)?)?\s*(;.*)?$/;

function parseRequirement(line: string, file: string, notes: string[]): Dependency | null {
  const m = line.match(REQUIREMENT);
  if (!m?.[1]) {
    notes.push(`${file}: couldn't read "${line}", skipped.`);
    return null;
  }
  const name = m[1];
  const spec = (m[3] ?? "").replace(/[()\s]/g, "");
  const exact = spec.match(/^===?([^,*]+)$/);
  if (exact?.[1]) return dep("PyPI", name, exact[1], spec, true, true, file);
  // Use the lower bound of ">=x" or "~=x" as a best guess.
  const lower = spec.match(/(?:^|,)(?:>=|~=)([^,]+)/);
  if (!spec)
    notes.push(`${file}: ${name} isn't pinned to a version; only its latest release is checked.`);
  return dep("PyPI", name, lower?.[1] ?? null, spec, true, false, file);
}

export function parseRequirementsTxt(text: string, file: string): ParseResult {
  const notes: string[] = [];
  const dependencies: Dependency[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (/^-(r|c)\s|^--(requirement|constraint)[ =]/.test(line)) {
      notes.push(`${file}: "${line}" includes another file; add that file to scan it too.`);
      continue;
    }
    if (line.startsWith("-")) continue; // --index-url, -e ., and other pip options
    if (/^(git\+|https?:|file:|\.{0,2}\/)/.test(line) || line.includes(" @ ")) {
      notes.push(`${file}: "${line}" isn't from PyPI, skipped.`);
      continue;
    }
    const d = parseRequirement(line, file, notes);
    if (d) dependencies.push(d);
  }
  return { dependencies, notes };
}

/** [project].dependencies from pyproject.toml (PEP 621). Minimal TOML: just that array. */
export function parsePyproject(text: string, file: string): ParseResult {
  const notes: string[] = [];
  const project = text.match(/^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  const array = project.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  if (array === undefined) {
    if (/^\[tool\.poetry\.dependencies\]/m.test(text)) {
      notes.push(
        `${file}: Poetry-style dependencies aren't supported yet; scan poetry.lock or requirements.txt instead.`,
      );
    }
    return { dependencies: [], notes };
  }
  const dependencies: Dependency[] = [];
  for (const m of array.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const d = parseRequirement((m[1] ?? m[2] ?? "").trim(), file, notes);
    if (d) dependencies.push(d);
  }
  return { dependencies, notes };
}

/**
 * Parses every supported file and merges the results. When a directory has
 * both package.json and package-lock.json, the lockfile's exact versions win
 * and package.json supplies the declared ranges.
 */
export function parseManifests(files: Array<{ path: string; text: string }>): ParseResult {
  const notes: string[] = [];
  const byKey = new Map<string, Dependency>();
  const lockDirs = new Set(
    files.filter((f) => baseName(f.path) === "package-lock.json").map((f) => dirName(f.path)),
  );
  const declaredNpm = new Map<string, string>();

  const add = (d: Dependency) => {
    const key = `${d.ecosystem}:${normalizeName(d.ecosystem, d.name)}@${d.version ?? "?"}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, d);
      return;
    }
    existing.direct ||= d.direct;
    existing.resolved ||= d.resolved;
    existing.declared ||= d.declared;
    for (const f of d.files) if (!existing.files.includes(f)) existing.files.push(f);
  };

  for (const f of files) {
    const name = baseName(f.path);
    let result: ParseResult;
    if (name === "package.json") {
      result = parsePackageJson(f.text, f.path);
      if (lockDirs.has(dirName(f.path)) || lockDirs.has("")) {
        // The lockfile has the real versions; keep only the declared ranges from here.
        for (const d of result.dependencies) declaredNpm.set(d.name, d.declared);
        notes.push(...result.notes);
        continue;
      }
      notes.push(
        `${f.path}: no package-lock.json next to it, so versions are the lowest each range allows.`,
      );
    } else if (name === "package-lock.json") result = parsePackageLock(f.text, f.path);
    else if (name === "pyproject.toml") result = parsePyproject(f.text, f.path);
    else result = parseRequirementsTxt(f.text, f.path);
    notes.push(...result.notes);
    result.dependencies.forEach(add);
  }

  const dependencies = [...byKey.values()];
  const npmVersions = new Map<string, number>();
  for (const d of dependencies) {
    if (d.ecosystem === "npm") npmVersions.set(d.name, (npmVersions.get(d.name) ?? 0) + 1);
  }
  for (const d of dependencies) {
    const declared = d.ecosystem === "npm" ? declaredNpm.get(d.name) : undefined;
    if (declared === undefined) continue;
    // Workspace packages' own dependencies are installed at the root but not listed in the
    // root package.json; when only one version is installed, it's the one they declared.
    if (!d.direct && npmVersions.get(d.name) === 1) d.direct = true;
    if (d.direct) d.declared ||= declared;
  }
  return { dependencies, notes: [...new Set(notes)] };
}

import semver from "semver";
import type { Ecosystem } from "./types.js";

/**
 * Version comparison for npm (semver) and PyPI (PEP 440, the common subset:
 * epochs, release numbers, a/b/rc pre-releases, .post and .dev).
 */

interface Pep440 {
  epoch: number;
  release: number[];
  /** a=0, b=1, rc=2; final release sorts after them. */
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
}

const PEP440 =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9.]+)?$/i;

const PRE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

export function parsePep440(version: string): Pep440 | null {
  const m = version.trim().match(PEP440);
  if (!m) return null;
  const [, epoch, release, preLabel, preNum, postImplicit, postNum, devNum] = m;
  return {
    epoch: epoch ? Number(epoch) : 0,
    release: (release ?? "0").split(".").map(Number),
    pre: preLabel ? [PRE_RANK[preLabel.toLowerCase()] ?? 0, Number(preNum || 0)] : null,
    post:
      postImplicit !== undefined
        ? Number(postImplicit)
        : postNum !== undefined
          ? Number(postNum || 0)
          : null,
    dev: devNum !== undefined ? Number(devNum || 0) : null,
  };
}

function cmpPep440(a: Pep440, b: Pep440): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i++) {
    const d = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (d !== 0) return d;
  }
  // Order within one release: X.devN < X.aN < X.bN < X.rcN < X < X.postN
  const phase = (v: Pep440) => (v.pre ? 1 : v.dev !== null && v.post === null ? 0 : 2);
  const pa = phase(a);
  const pb = phase(b);
  if (pa !== pb) return pa - pb;
  if (a.pre && b.pre) {
    if (a.pre[0] !== b.pre[0]) return a.pre[0] - b.pre[0];
    if (a.pre[1] !== b.pre[1]) return a.pre[1] - b.pre[1];
  }
  const post = (a.post ?? -1) - (b.post ?? -1);
  if (post !== 0) return post;
  // A dev release sorts before the same version without .dev.
  // (Compare explicitly: Infinity - Infinity would be NaN, not 0.)
  if (a.dev === b.dev) return 0;
  if (a.dev === null) return 1;
  if (b.dev === null) return -1;
  return a.dev - b.dev;
}

/** Exact semver as-is; otherwise the closest semver ("1.2" -> "1.2.0"). */
function toSemver(v: string): string | null {
  return semver.valid(v) ?? semver.coerce(v, { includePrerelease: true })?.version ?? null;
}

/** Negative if a < b, positive if a > b, 0 if equal; null if either can't be parsed. */
export function compareVersions(ecosystem: Ecosystem, a: string, b: string): number | null {
  if (ecosystem === "npm") {
    const pa = toSemver(a);
    const pb = toSemver(b);
    return pa && pb ? semver.compare(pa, pb) : null;
  }
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  return cmpPep440(pa, pb);
}

export function majorOf(ecosystem: Ecosystem, version: string): number | null {
  if (ecosystem === "npm") {
    const v = semver.valid(version) ?? semver.coerce(version)?.version;
    return v ? semver.major(v) : null;
  }
  const p = parsePep440(version);
  return p ? (p.release[0] ?? 0) : null;
}

/** How far `from` is behind `to`: the highest version component that differs. */
export function behindLevel(
  ecosystem: Ecosystem,
  from: string,
  to: string,
): "none" | "patch" | "minor" | "major" | "unknown" {
  const cmp = compareVersions(ecosystem, from, to);
  if (cmp === null) return "unknown";
  if (cmp >= 0) return "none";
  if (ecosystem === "npm") {
    const a = semver.coerce(from);
    const b = semver.coerce(to);
    if (!a || !b) return "unknown";
    // 0.x.y: a minor bump is breaking by semver convention.
    if (a.major !== b.major || (a.major === 0 && a.minor !== b.minor)) return "major";
    return a.minor !== b.minor ? "minor" : "patch";
  }
  const a = parsePep440(from);
  const b = parsePep440(to);
  if (!a || !b) return "unknown";
  if ((a.release[0] ?? 0) !== (b.release[0] ?? 0)) return "major";
  return (a.release[1] ?? 0) !== (b.release[1] ?? 0) ? "minor" : "patch";
}

/** True when moving from `from` to `to` crosses a major version (a likely breaking change). */
export function isMajorJump(ecosystem: Ecosystem, from: string, to: string): boolean {
  return behindLevel(ecosystem, from, to) === "major";
}

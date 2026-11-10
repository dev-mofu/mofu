import { describe, expect, it } from "vitest";
import {
  behindLevel,
  compareVersions,
  cvss3BaseScore,
  findUnverifiedReferences,
  fixVersionFor,
  formatScanMarkdown,
  isAffected,
  isMajorJump,
  parseManifests,
  parsePackageJson,
  parsePackageLock,
  parsePyproject,
  parseRequirementsTxt,
  scanDependencies,
  type ScanReport,
} from "../src/index.js";

describe("version comparison", () => {
  it.each([
    ["npm", "1.2.3", "1.2.4", -1],
    ["npm", "2.0.0", "1.9.9", 1],
    ["npm", "1.0.0-beta.1", "1.0.0", -1],
    ["PyPI", "2.2.5", "2.2.5", 0],
    ["PyPI", "2.0", "2.0.0", 0],
    ["PyPI", "1.0.dev1", "1.0a1", -1],
    ["PyPI", "1.0a1", "1.0b1", -1],
    ["PyPI", "1.0rc1", "1.0", -1],
    ["PyPI", "1.0", "1.0.post1", -1],
    ["PyPI", "1!0.1", "2.0", 1],
    ["PyPI", "2.10", "2.9", 1],
  ] as const)("%s %s vs %s", (eco, a, b, sign) => {
    expect(Math.sign(compareVersions(eco, a, b) ?? NaN)).toBe(sign);
  });

  it("classifies how far behind and major jumps", () => {
    expect(behindLevel("npm", "4.17.15", "4.18.1")).toBe("minor");
    expect(behindLevel("npm", "18.2.0", "19.3.1")).toBe("major");
    expect(behindLevel("npm", "0.3.0", "0.4.0")).toBe("major"); // 0.x minor bumps break
    expect(behindLevel("PyPI", "2.19.0", "2.19.1")).toBe("patch");
    expect(isMajorJump("PyPI", "2.0", "3.1.3")).toBe(true);
    expect(behindLevel("npm", "2.0.0", "1.0.0")).toBe("none");
  });
});

describe("parsers", () => {
  it("reads package.json ranges and skips non-registry specs", () => {
    const { dependencies, notes } = parsePackageJson(
      JSON.stringify({
        dependencies: {
          lodash: "^4.17.15",
          mine: "workspace:*",
          gh: "user/repo",
          tar: "git+https://x/y.git",
        },
        devDependencies: { vitest: "5.1.0" },
      }),
      "package.json",
    );
    expect(dependencies.map((d) => [d.name, d.version, d.resolved])).toEqual([
      ["vitest", "5.1.0", true],
      ["lodash", "4.17.15", false],
    ]);
    expect(notes).toHaveLength(3);
  });

  it("reads lockfile v3 including nested and scoped packages, skipping workspace links", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { lodash: "^4.17.0", "@scope/pkg": "^1.0.0" } },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/@scope/pkg": { version: "1.2.0" },
        "node_modules/a/node_modules/lodash": { version: "3.10.1" },
        "node_modules/my-workspace": { link: true, resolved: "packages/my-workspace" },
        "packages/my-workspace": { version: "0.0.0" },
      },
    };
    const { dependencies, notes } = parsePackageLock(JSON.stringify(lock), "package-lock.json");
    expect(dependencies.map((d) => `${d.name}@${d.version}:${d.direct}`).sort()).toEqual([
      "@scope/pkg@1.2.0:true",
      "lodash@3.10.1:false",
      "lodash@4.17.21:true",
    ]);
    expect(notes[0]).toMatch(/workspace package link/);
  });

  it("explains old lockfiles instead of crashing", () => {
    const { dependencies, notes } = parsePackageLock(
      JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
      "package-lock.json",
    );
    expect(dependencies).toEqual([]);
    expect(notes[0]).toMatch(/version 1 isn't supported/);
  });

  it("reads requirements.txt pins, ranges, extras, markers and options", () => {
    const { dependencies, notes } = parseRequirementsTxt(
      [
        "# comment",
        "requests[security]==2.19.0 ; python_version >= '3.8'",
        "Flask>=2.0,<3  # web",
        "numpy",
        "-r dev.txt",
        "--index-url https://example.com",
        "-e .",
        "git+https://github.com/x/y.git",
        "pkg @ https://example.com/pkg.whl",
      ].join("\n"),
      "requirements.txt",
    );
    expect(dependencies.map((d) => [d.name, d.version, d.resolved])).toEqual([
      ["requests", "2.19.0", true],
      ["Flask", "2.0", false],
      ["numpy", null, false],
    ]);
    expect(notes.join("\n")).toMatch(/numpy isn't pinned/);
    expect(notes.join("\n")).toMatch(/includes another file/);
    expect(notes.filter((n) => n.includes("isn't from PyPI"))).toHaveLength(2);
  });

  it("reads [project].dependencies from pyproject.toml and flags Poetry", () => {
    const toml = `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "x"\ndependencies = [\n  "fastapi==0.110.0",\n  'pydantic>=2',\n]\n\n[tool.ruff]\nline-length = 100\n`;
    expect(parsePyproject(toml, "pyproject.toml").dependencies.map((d) => d.name)).toEqual([
      "fastapi",
      "pydantic",
    ]);
    expect(
      parsePyproject("[tool.poetry.dependencies]\npython = '^3.11'\n", "pyproject.toml").notes[0],
    ).toMatch(/Poetry/);
  });

  it("prefers lockfile versions over package.json guesses", () => {
    const { dependencies } = parseManifests([
      { path: "package.json", text: JSON.stringify({ dependencies: { lodash: "^4.17.0" } }) },
      {
        path: "package-lock.json",
        text: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { lodash: "^4.17.0" } },
            "node_modules/lodash": { version: "4.17.21" },
          },
        }),
      },
    ]);
    expect(dependencies).toEqual([
      expect.objectContaining({
        name: "lodash",
        version: "4.17.21",
        declared: "^4.17.0",
        direct: true,
        resolved: true,
      }),
    ]);
  });
});

describe("affected ranges and fixes", () => {
  const entry = (events: Array<Record<string, string>>, versions?: string[]) => ({
    package: { name: "flask", ecosystem: "PyPI" },
    ranges: [{ type: "ECOSYSTEM", events }],
    ...(versions && { versions }),
  });

  it("evaluates introduced, fixed and last_affected", () => {
    const e = entry([{ introduced: "0" }, { fixed: "2.2.5" }]);
    expect(isAffected(e, "PyPI", "2.0")).toBe(true);
    expect(isAffected(e, "PyPI", "2.2.5")).toBe(false);
    const last = entry([{ introduced: "1.0" }, { last_affected: "1.5" }]);
    expect(isAffected(last, "PyPI", "1.5")).toBe(true);
    expect(isAffected(last, "PyPI", "1.6")).toBe(false);
    expect(isAffected(last, "PyPI", "0.9")).toBe(false);
  });

  it("finds the smallest version that fixes every vulnerability", () => {
    const vulns = [
      {
        id: "A",
        affected: [
          entry([{ introduced: "0" }, { fixed: "2.2.5" }]),
          entry([{ introduced: "2.3.0" }, { fixed: "2.3.2" }]),
        ],
      },
      { id: "B", affected: [entry([{ introduced: "0" }, { fixed: "3.1.3" }])] },
    ];
    expect(fixVersionFor(vulns, "PyPI", "flask", "2.0")).toBe("3.1.3");
    expect(fixVersionFor([vulns[0]!], "PyPI", "flask", "2.0")).toBe("2.2.5");
    // Moving to 2.3.0 lands in the second range of A: the fix must skip past it.
    expect(fixVersionFor([vulns[0]!], "PyPI", "flask", "2.3.0")).toBe("2.3.2");
  });

  it("returns null when a vulnerability has no published fix", () => {
    const noFix = [{ id: "C", affected: [entry([{ introduced: "0" }])] }];
    expect(fixVersionFor(noFix, "PyPI", "flask", "1.0")).toBeNull();
  });
});

describe("CVSS", () => {
  it.each([
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H", 7.4],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L", 5.3],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0],
  ])("%s = %d", (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score);
  });

  it("ignores other CVSS versions", () => {
    expect(cvss3BaseScore("CVSS:4.0/AV:N/AC:L")).toBeNull();
  });
});

/** Fake OSV + deps.dev with one vulnerable lodash and one deprecated, abandoned package. */
function fakeApis(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/querybatch")) {
      const body = JSON.parse(String(init?.body)) as {
        queries: Array<{ package: { name: string }; page_token?: string }>;
      };
      // Pagination: the first page for lodash has a token; the second page adds another ID.
      return json({
        results: body.queries.map((q) =>
          q.package.name !== "lodash"
            ? {}
            : q.page_token
              ? { vulns: [{ id: "GHSA-29mw-wpgm-hmr9" }] }
              : {
                  vulns: [{ id: "GHSA-p6mc-m468-83gw" }, { id: "PYSEC-DUP" }],
                  next_page_token: "p2",
                },
        ),
      });
    }
    if (url.includes("/vulns/GHSA-p6mc-m468-83gw")) {
      return json({
        id: "GHSA-p6mc-m468-83gw",
        summary: "Prototype Pollution in lodash",
        aliases: ["CVE-2020-8203"],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H" }],
        database_specific: { severity: "HIGH" },
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.19" }] }],
          },
        ],
      });
    }
    if (url.includes("/vulns/PYSEC-DUP")) {
      // Same issue under another database's ID: must be merged, not double-counted.
      return json({ id: "PYSEC-DUP", aliases: ["CVE-2020-8203"], affected: [] });
    }
    if (url.includes("/vulns/GHSA-29mw-wpgm-hmr9")) {
      return json({
        id: "GHSA-29mw-wpgm-hmr9",
        summary: "ReDoS in lodash",
        database_specific: { severity: "MODERATE" },
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "4.0.0" }, { fixed: "4.17.21" }] }],
          },
        ],
      });
    }
    if (url.includes("deps.dev") && url.endsWith("/lodash")) {
      return json({
        versions: [
          { versionKey: { version: "4.17.15" }, publishedAt: "2019-07-19T00:00:00Z" },
          { versionKey: { version: "4.17.21" }, publishedAt: "2021-02-20T00:00:00Z" },
          {
            versionKey: { version: "4.18.1" },
            publishedAt: "2026-04-01T00:00:00Z",
            isDefault: true,
          },
        ],
      });
    }
    if (url.includes("deps.dev") && url.endsWith("/left-pad")) {
      return json({
        versions: [
          {
            versionKey: { version: "1.3.0" },
            publishedAt: "2018-04-09T00:00:00Z",
            isDefault: true,
            isDeprecated: true,
          },
        ],
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

describe("scanDependencies", () => {
  const files = [
    {
      path: "package.json",
      text: JSON.stringify({ dependencies: { lodash: "4.17.15", "left-pad": "1.3.0" } }),
    },
  ];

  it("builds a report from OSV and deps.dev data", async () => {
    const { fetch, calls } = fakeApis();
    const report = await scanDependencies(files, { fetch, now: new Date("2026-11-10T00:00:00Z") });
    const lodash = report.findings.find((f) => f.name === "lodash");
    expect(lodash).toMatchObject({
      version: "4.17.15",
      worstSeverity: "high",
      fixVersion: "4.17.21",
      fixIsMajor: false,
      latest: "4.18.1",
      behind: "minor",
      deprecated: false,
    });
    expect(lodash?.vulnerabilities.map((v) => v.id)).toEqual([
      "GHSA-p6mc-m468-83gw",
      "GHSA-29mw-wpgm-hmr9",
    ]);
    expect(lodash?.vulnerabilities[0]?.score).toBe(7.4);
    expect(report.findings.find((f) => f.name === "left-pad")).toMatchObject({
      deprecated: true,
      possiblyUnmaintained: true,
    });
    expect(report.totals).toMatchObject({
      vulnerabilities: 2,
      vulnerablePackages: 1,
      deprecated: 1,
    });
    // One OSV batch + one page-2 batch, not one request per package.
    expect(calls.filter((u) => u.endsWith("/querybatch"))).toHaveLength(2);
  });

  it("renders Markdown with links and flags unverified references", async () => {
    const { fetch } = fakeApis();
    const report: ScanReport = await scanDependencies(files, {
      fetch,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    const md = formatScanMarkdown(report, "Upgrade lodash first.");
    expect(md).toContain(
      "[GHSA-p6mc-m468-83gw](https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw)",
    );
    expect(md).toContain("Upgrade lodash first.");
    const text =
      "Fix CVE-2020-8203 and CVE-2099-12345 by moving lodash to 4.17.21, or 4.17.99. CVSS 3.1 score 7.4.";
    expect(findUnverifiedReferences(text, report)).toEqual({
      ids: ["CVE-2099-12345"],
      versions: ["4.17.99"],
    });
  });
});

describe("safeRelease", () => {
  const vuln = {
    id: "GHSA-x",
    affected: [
      {
        package: { name: "lodash", ecosystem: "npm" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.18.0" }] }],
      },
    ],
  };
  const dep = {
    ecosystem: "npm" as const,
    name: "lodash",
    version: "4.17.15",
    declared: "",
    direct: true,
    resolved: true,
    files: [],
  };

  it("skips a deprecated minimal fix and pre-releases", async () => {
    const { safeRelease } = await import("../src/index.js");
    const info = {
      latest: "4.18.1",
      lastRelease: null,
      deprecated: new Set(["4.18.0"]),
      versions: ["4.17.15", "4.18.0", "4.18.1-beta.1", "4.18.1"],
    };
    expect(safeRelease("4.18.0", info, [vuln], dep)).toBe("4.18.1");
  });

  it("keeps the minimal fix when nothing better is known", async () => {
    const { safeRelease } = await import("../src/index.js");
    const info = {
      latest: "4.18.0",
      lastRelease: null,
      deprecated: new Set(["4.18.0"]),
      versions: ["4.18.0"],
    };
    expect(safeRelease("4.18.0", info, [vuln], dep)).toBe("4.18.0");
  });
});

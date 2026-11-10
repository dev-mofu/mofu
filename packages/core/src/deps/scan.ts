import { mapLimit, type HttpOptions } from "./http.js";
import { parseManifests } from "./parse.js";
import { fetchOsvVulns, fetchPackageInfo, queryOsvBatch, type PackageInfo } from "./sources.js";
import { buildScanReport, infoKey } from "./analyze.js";
import { depKey, type Dependency, type ScanReport } from "./types.js";

export interface ScanOptions extends HttpOptions {
  now?: Date;
  /** Short status lines for the UI, e.g. "Checking 214 packages against OSV…". */
  onProgress?: (message: string) => void;
}

/** Registry lookups are for direct dependencies only; transitive ones are checked for vulnerabilities. */
const MAX_METADATA = 150;
const MAX_VULN_DETAILS = 300;

// One scan's worth of lookups, shared across scans in the same process/page.
const infoCache = new Map<string, Promise<PackageInfo | null>>();

/**
 * Deterministic dependency scan: parse manifests, look up vulnerabilities on
 * OSV and registry data on deps.dev, then build the report. No model involved.
 */
export async function scanDependencies(
  files: Array<{ path: string; text: string }>,
  opts: ScanOptions = {},
): Promise<ScanReport> {
  const { dependencies, notes } = parseManifests(files);
  const http: HttpOptions = {
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.signal && { signal: opts.signal }),
  };

  const queryable = dependencies.filter(
    (d): d is Dependency & { version: string } => d.version !== null,
  );
  const unversioned = dependencies.length - queryable.length;
  if (unversioned > 0) {
    notes.push(
      `${unversioned} dependenc${unversioned === 1 ? "y has" : "ies have"} no known version, so vulnerabilities couldn't be checked for them.`,
    );
  }

  opts.onProgress?.(`Checking ${queryable.length} packages against OSV…`);
  const idLists = await queryOsvBatch(
    queryable.map((d) => ({ ecosystem: d.ecosystem, name: d.name, version: d.version })),
    http,
  );
  const vulnIds = new Map<string, string[]>();
  queryable.forEach((d, i) => vulnIds.set(depKey(d), idLists[i] ?? []));

  const allIds = [...new Set(idLists.flat())];
  if (allIds.length > MAX_VULN_DETAILS) {
    notes.push(
      `Found ${allIds.length} vulnerability records; details were fetched for the first ${MAX_VULN_DETAILS}.`,
    );
  }
  opts.onProgress?.(`Reading ${Math.min(allIds.length, MAX_VULN_DETAILS)} vulnerability records…`);
  const vulns = await fetchOsvVulns(allIds.slice(0, MAX_VULN_DETAILS), http);

  const direct = [
    ...new Map(
      dependencies.filter((d) => d.direct).map((d) => [infoKey(d.ecosystem, d.name), d]),
    ).values(),
  ];
  if (direct.length > MAX_METADATA) {
    notes.push(
      `${direct.length} direct dependencies; release data was checked for the first ${MAX_METADATA}.`,
    );
  }
  opts.onProgress?.(
    `Checking release data for ${Math.min(direct.length, MAX_METADATA)} direct dependencies…`,
  );
  const info = new Map<string, PackageInfo | null>();
  await mapLimit(direct.slice(0, MAX_METADATA), 6, async (d) => {
    const key = infoKey(d.ecosystem, d.name);
    if (!infoCache.has(key)) {
      infoCache.set(
        key,
        fetchPackageInfo(d.ecosystem, d.name, http).catch(() => null),
      );
    }
    info.set(key, await infoCache.get(key)!);
  });

  return buildScanReport({
    dependencies,
    notes,
    files: files.map((f) => f.path),
    vulnIds,
    vulns,
    info,
    now: opts.now ?? new Date(),
  });
}

export { scanDependencies } from "./scan.js";
export type { ScanOptions } from "./scan.js";
export {
  parseManifests,
  parsePackageJson,
  parsePackageLock,
  parsePyproject,
  parseRequirementsTxt,
  MANIFEST_PATTERN,
} from "./parse.js";
export { formatScanForModel, formatScanMarkdown, findUnverifiedReferences } from "./format.js";
export {
  cvss3BaseScore,
  fixVersionFor,
  isAffected,
  buildScanReport,
  safeRelease,
} from "./analyze.js";
export { compareVersions, behindLevel, isMajorJump, parsePep440 } from "./versions.js";
export { SEVERITIES, ScanReportSchema, normalizeName } from "./types.js";
export type {
  Dependency,
  Ecosystem,
  Finding,
  ParseResult,
  ScanReport,
  Severity,
  Vulnerability,
} from "./types.js";

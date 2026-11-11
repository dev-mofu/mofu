import type { TokenScanReport } from "./api.js";

/** Plain text of a report for the model; the report is data, the model only explains it. */
export function formatTokenScanForModel(r: TokenScanReport): string {
  const t = r.token;
  return [
    `Contract: ${r.address} on ${r.chainName}`,
    `Token: ${t.name ?? "unknown name"} (${t.symbol ?? "no symbol"}), decimals ${t.decimals ?? "unknown"}, total supply ${t.totalSupply ?? "unknown"}`,
    `Code size: ${r.codeSize} bytes. Proxy: ${r.proxy.kind}${r.proxy.implementation ? ` → ${r.proxy.implementation}` : ""}`,
    `Owner: ${r.owner.status}${r.owner.address ? ` ${r.owner.address}` : ""}${r.owner.holdsPercent !== null ? `, holds ${r.owner.holdsPercent}%` : ""}`,
    `Burned: ${r.burnedPercent ?? "unknown"}%`,
    `Overall: ${r.verdict}`,
    "Checks:",
    ...r.checks.map((c) => `- [${c.status}] ${c.label} ${c.detail}`),
    "Not covered:",
    ...r.limits.map((l) => `- ${l}`),
  ].join("\n");
}

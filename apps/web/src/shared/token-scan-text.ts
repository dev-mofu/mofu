import type { TokenScanReport, TxReport } from "./api.js";

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
    ...(r.distribution.status === "unavailable"
      ? []
      : [
          `Top 10 holders (excluding burned) hold ${r.distribution.top10Percent}% of supply; biggest plain wallet ${r.distribution.largestWallet ? `${r.distribution.largestWallet.address} with ${r.distribution.largestWallet.percent}%` : "none"}.`,
          ...r.distribution.holders.map(
            (h, i) =>
              `  #${i + 1} ${h.address} ${h.percent}% (${h.kind === "contract" ? "contract, likely pool or curve" : h.kind})`,
          ),
          ...(r.distribution.status === "summary"
            ? ["(Full holder list and creator details are a $MOFU holder perk.)"]
            : []),
        ]),
    ...(r.origin
      ? [
          `Created by ${r.origin.creator}${r.origin.launcher ? ` through launcher ${r.origin.launcher}` : ""} on ${r.origin.createdAt ?? "unknown date"}.`,
          `Creator wallet: first seen ${r.origin.creatorFirstSeen ?? "unknown"} (${r.origin.creatorAgeDays ?? "?"} days), ${r.origin.creatorTxCount ?? "?"} transactions, still holds ${r.origin.creatorHoldsPercent ?? "?"}% of supply, launched ${r.origin.otherLaunchCount} other tokens through the same launcher recently.`,
        ]
      : []),
    "Not covered:",
    ...r.limits.map((l) => `- ${l}`),
  ].join("\n");
}

/** Plain text of a decoded transaction for the model. */
export function formatTxForModel(r: TxReport): string {
  return [
    `Transaction ${r.hash} on ${r.chainName}: ${r.status}${r.time ? ` at ${r.time}` : ""}`,
    `From ${r.from} to ${r.to ?? "(contract creation)"}${r.toIsContract ? " (a contract)" : r.toIsContract === false ? " (a wallet)" : ""}. Value ${r.valueEth} ETH, fee ${r.feeEth} ETH.`,
    "Token transfers:",
    ...(r.transfers.length
      ? r.transfers.map(
          (t) =>
            `- ${t.amount} ${t.symbol ?? t.token} from ${t.mint ? "mint (new tokens)" : t.from} to ${t.burn ? `burn address ${t.to}` : t.to}`,
        )
      : ["- none"]),
    "Approvals:",
    ...(r.approvals.length
      ? r.approvals.map(
          (a) =>
            `- ${a.owner} let ${a.spender}${a.spenderIsContract === false ? " (a plain wallet)" : ""} spend ${a.amount} ${a.symbol ?? a.token}`,
        )
      : ["- none"]),
    `Other events: ${r.otherEvents.join(", ") || "none"}`,
    "Flags:",
    ...(r.flags.length ? r.flags.map((f) => `- [${f.level}] ${f.text}`) : ["- none"]),
  ].join("\n");
}

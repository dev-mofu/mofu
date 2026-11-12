/**
 * `mofu audit`: a quick static read of Solidity source, before deployment.
 *
 * Two parts:
 * - what Mofu's Token Scanner is likely to say once the token is live (mint, pause, blacklist,
 *   fees, limits, upgrades, self-destruct, balance edits, sell restrictions, owner);
 * - common bug patterns (tx.origin auth, unchecked low-level calls, reentrancy-shaped code,
 *   block-based randomness, old compilers).
 *
 * It's pattern matching on the source, not a compiler or a formal audit: it can miss things and
 * it can flag things that are fine. Every finding points at a line so a person can check it.
 */

export type AuditStatus = "ok" | "info" | "warn" | "risk";

export interface AuditCheck {
  id:
    | "mint"
    | "pause"
    | "blacklist"
    | "fees"
    | "limits"
    | "upgrade"
    | "destroy"
    | "balances"
    | "sells"
    | "owner";
  label: string;
  status: AuditStatus;
  detail: string;
  lines: number[];
}

export interface AuditIssue {
  id: string;
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  line: number;
  snippet: string;
}

export interface FileAudit {
  file: string;
  contracts: string[];
  checks: AuditCheck[];
  issues: AuditIssue[];
  /** What the Token Scanner would most likely say: from the checks. */
  verdict: "clean" | "caution" | "risky";
}

export const AUDIT_LIMITS = [
  "This reads the source with patterns; it doesn't compile it or follow inherited code from libraries you don't include.",
  "A clean result isn't an audit. Have contracts that hold real value reviewed by people.",
];

interface Fn {
  name: string;
  header: string;
  body: string;
  /** 1-based line of the function keyword. */
  line: number;
  bodyStart: number;
  kind: "function" | "constructor" | "modifier" | "receive" | "fallback";
}

/** Comments and string contents become spaces, so patterns can't match inside them. Lines stay put. */
export function blankCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = () => {
    out.push(src[i] === "\n" ? "\n" : " ");
    i++;
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") blank();
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank();
      if (i < src.length) {
        blank();
        blank();
      }
    } else if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") blank();
        if (i < src.length) blank();
      }
      if (i < src.length) {
        out.push(src[i]!);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  return src.length - 1;
}

function functions(src: string): Fn[] {
  const out: Fn[] = [];
  const re =
    /\b(function\s+(\w+)|constructor|modifier\s+(\w+)|receive|fallback)\s*\(([^)]*)\)([^{;]*)\{/g;
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(src, open);
    const kind = m[1]!.startsWith("function")
      ? "function"
      : m[1]!.startsWith("modifier")
        ? "modifier"
        : (m[1] as Fn["kind"]);
    out.push({
      name: m[2] ?? m[3] ?? m[1]!,
      header: `${m[4]} ${m[5]}`,
      body: src.slice(open + 1, close),
      line: lineOf(src, m.index!),
      bodyStart: open + 1,
      kind,
    });
  }
  return out;
}

const RESTRICTED =
  /\b(only\w*|auth\w*|requiresAuth|whenNotPaused|ownerOnly)\b|_checkOwner\(|hasRole\(|msg\.sender\s*==\s*(owner|_owner|admin|dev\w*|marketing\w*)|_msgSender\(\)\s*==\s*(owner|_owner)/;
const callable = (f: Fn) => f.kind === "function" && !/\b(internal|private)\b/.test(f.header);
const restricted = (f: Fn) => RESTRICTED.test(f.header) || RESTRICTED.test(f.body.slice(0, 400));
const TRANSFER_PATH =
  /^(_transfer|_update|transfer|transferFrom|_beforeTokenTransfer|_afterTokenTransfer|_tokenTransfer)$/;

export function auditSolidity(file: string, source: string): FileAudit {
  const src = blankCommentsAndStrings(source);
  const lines = source.split("\n");
  const fns = functions(src);
  const contracts = [...src.matchAll(/\b(?:contract|abstract\s+contract)\s+(\w+)/g)].map(
    (m) => m[1]!,
  );
  const at = (index: number) => lineOf(src, index);
  const linesOf = (re: RegExp) =>
    [
      ...src.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)),
    ].map((m) => at(m.index!));
  const fnLine = (f: Fn, re: RegExp) => {
    const m = re.exec(f.body);
    return m ? lineOf(src, f.bodyStart + m.index) : f.line;
  };
  const checks: AuditCheck[] = [];
  const check = (c: AuditCheck) => checks.push({ ...c, lines: [...new Set(c.lines)].slice(0, 6) });

  // mint
  const minters = fns.filter(
    (f) => callable(f) && /\b_mint\s*\(|\b_?totalSupply\s*\+=/.test(f.body),
  );
  if (minters.length) {
    const open = minters.filter((f) => !restricted(f));
    check({
      id: "mint",
      label: "Can new tokens be created?",
      status: "risk",
      detail: open.length
        ? `Yes, and ${open.map((f) => `${f.name}()`).join(", ")} doesn't look access-controlled: anyone may be able to mint.`
        : `Yes: ${minters.map((f) => `${f.name}()`).join(", ")} can create tokens after deployment. The scanner will flag this unless ownership is renounced.`,
      lines: minters.map((f) => fnLine(f, /_mint\s*\(|totalSupply\s*\+=/)),
    });
  } else
    check({
      id: "mint",
      label: "Can new tokens be created?",
      status: "ok",
      detail: "No minting outside the constructor found.",
      lines: [],
    });

  // pause
  const pauseLines = linesOf(/\bwhenNotPaused\b|\b_pause\s*\(|\bPausable\b|\bpaused\s*=\s*true/);
  check(
    pauseLines.length
      ? {
          id: "pause",
          label: "Can transfers be paused?",
          status: "risk",
          detail: "Yes: the contract has a pause switch. Paused transfers mean nobody can sell.",
          lines: pauseLines,
        }
      : {
          id: "pause",
          label: "Can transfers be paused?",
          status: "ok",
          detail: "No pause switch found.",
          lines: [],
        },
  );

  // blacklist
  const blackVars = [
    ...src.matchAll(
      /mapping\s*\(\s*address\s*=>\s*bool\s*\)\s*(?:public|private|internal)?\s*(\w*(?:black|bot|blocked|banned|deny|frozen|sniper|isBlack)\w*)/gi,
    ),
  ].map((m) => m[1]!);
  const blackSetters = fns.filter(
    (f) =>
      callable(f) &&
      blackVars.some((v) => new RegExp(`\\b${v}\\s*\\[[^\\]]+\\]\\s*=`).test(f.body)),
  );
  check(
    blackSetters.length
      ? {
          id: "blacklist",
          label: "Can wallets be blocked?",
          status: "risk",
          detail: `Yes: ${blackSetters.map((f) => `${f.name}()`).join(", ")} sets ${blackVars.join(", ")}, which can stop wallets from moving tokens.`,
          lines: blackSetters.map((f) => f.line),
        }
      : {
          id: "blacklist",
          label: "Can wallets be blocked?",
          status: "ok",
          detail: "No blacklist found.",
          lines: [],
        },
  );

  // fees
  const feeVars = [
    ...new Set(
      [
        ...src.matchAll(
          /\b(?:uint\d*|uint)\s+(?:public\s+|private\s+|internal\s+)?(\w*(?:fee|tax|Fee|Tax)\w*)\s*[=;]/g,
        ),
      ].map((m) => m[1]!),
    ),
  ];
  const feeSetters = fns.filter(
    (f) =>
      callable(f) &&
      f.kind === "function" &&
      feeVars.some((v) => new RegExp(`\\b${v}\\s*=`).test(f.body)),
  );
  if (feeSetters.length) {
    const capped = feeSetters.filter((f) =>
      /require\s*\([^;]*(<=|<)\s*\d+|if\s*\([^)]*>\s*\d+\)\s*revert/.test(f.body),
    );
    const uncapped = feeSetters.filter((f) => !capped.includes(f));
    check({
      id: "fees",
      label: "Can fees or taxes be changed?",
      status: uncapped.length ? "risk" : "warn",
      detail: uncapped.length
        ? `Yes, with no upper limit in ${uncapped.map((f) => `${f.name}()`).join(", ")}: a fee of 100% would make selling pointless.`
        : `Yes, but ${capped.map((f) => `${f.name}()`).join(", ")} checks a maximum.`,
      lines: feeSetters.map((f) => f.line),
    });
  } else
    check({
      id: "fees",
      label: "Can fees or taxes be changed?",
      status: feeVars.length ? "info" : "ok",
      detail: feeVars.length
        ? `Fee settings (${feeVars.join(", ")}) exist but nothing changes them after deployment.`
        : "No fee or tax settings found.",
      lines: [],
    });

  // limits
  const limitLines = linesOf(
    /\b(maxTx\w*|maxWallet\w*|maxTransaction\w*|tradingEnabled|tradingOpen|tradingActive|enableTrading|limitsInEffect|_maxTxAmount)\b/,
  );
  check(
    limitLines.length
      ? {
          id: "limits",
          label: "Can trading limits be set?",
          status: "warn",
          detail:
            "Yes: there are trading limits or a trading switch. Until trading is on or limits are lifted, buys and sells can fail.",
          lines: limitLines,
        }
      : {
          id: "limits",
          label: "Can trading limits be set?",
          status: "ok",
          detail: "No trading limits or trading switch found.",
          lines: [],
        },
  );

  // upgrade
  const upLines = linesOf(
    /\bUUPSUpgradeable\b|\bupgradeTo\w*\s*\(|\bInitializable\b|\bdelegatecall\s*\(/,
  );
  check(
    upLines.length
      ? {
          id: "upgrade",
          label: "Can the code be changed?",
          status: "warn",
          detail:
            "Yes: the contract is upgradeable or uses delegatecall, so what it does can change after you check it.",
          lines: upLines,
        }
      : {
          id: "upgrade",
          label: "Can the code be changed?",
          status: "ok",
          detail: "Not upgradeable.",
          lines: [],
        },
  );

  // self-destruct
  const sdLines = linesOf(/\bselfdestruct\s*\(|\bsuicide\s*\(/);
  check(
    sdLines.length
      ? {
          id: "destroy",
          label: "Can the contract be destroyed?",
          status: "risk",
          detail: "It calls selfdestruct.",
          lines: sdLines,
        }
      : {
          id: "destroy",
          label: "Can the contract be destroyed?",
          status: "ok",
          detail: "No self-destruct.",
          lines: [],
        },
  );

  // direct balance edits
  const editors = fns.filter(
    (f) =>
      f.kind === "function" &&
      !TRANSFER_PATH.test(f.name) &&
      !/^_(mint|burn)$/.test(f.name) &&
      /\b_?balances?\s*\[[^\]]+\]\s*=(?!=)/.test(f.body),
  );
  check(
    editors.length
      ? {
          id: "balances",
          label: "Can balances be edited?",
          status: "risk",
          detail: `${editors.map((f) => `${f.name}()`).join(", ")} writes a balance directly, outside normal transfers: whoever calls it can change what wallets hold.`,
          lines: editors.map((f) => fnLine(f, /balances?\s*\[[^\]]+\]\s*=/)),
        }
      : {
          id: "balances",
          label: "Can balances be edited?",
          status: "ok",
          detail: "Balances change only through transfers, mints and burns.",
          lines: [],
        },
  );

  // sell restrictions inside the transfer path
  const transferFns = fns.filter((f) => TRANSFER_PATH.test(f.name));
  const sellGate = transferFns.find(
    (f) =>
      /\b(\w*[pP]air\w*|amm\w*|\w*[rR]outer\w*)\b/.test(f.body) &&
      /\brequire\s*\(|\brevert\b/.test(f.body),
  );
  check(
    sellGate
      ? {
          id: "sells",
          label: "Are sells treated differently?",
          status: "warn",
          detail: `${sellGate.name}() checks the pool or router and can revert: read those conditions, they decide whether people can sell.`,
          lines: [fnLine(sellGate, /\b(\w*[pP]air\w*|amm\w*|\w*[rR]outer\w*)\b/)],
        }
      : {
          id: "sells",
          label: "Are sells treated differently?",
          status: "ok",
          detail: "No pool-specific conditions in the transfer code.",
          lines: [],
        },
  );

  // owner
  const ownerLines = linesOf(/\bOwnable\w*\b|\bonlyOwner\b|\bAccessControl\b/);
  const privileged = fns.filter((f) => callable(f) && restricted(f)).map((f) => `${f.name}()`);
  check(
    ownerLines.length || privileged.length
      ? {
          id: "owner",
          label: "Who controls the contract?",
          status: "info",
          detail: `An owner or admin role${privileged.length ? ` can call ${[...new Set(privileged)].slice(0, 8).join(", ")}` : ""}. The scanner checks whether ownership has been renounced.`,
          lines: ownerLines.slice(0, 1),
        }
      : {
          id: "owner",
          label: "Who controls the contract?",
          status: "ok",
          detail: "No owner or admin role found.",
          lines: [],
        },
  );

  // ------------------------------------------------------------- bug patterns
  const issues: AuditIssue[] = [];
  const issue = (
    id: string,
    severity: AuditIssue["severity"],
    title: string,
    detail: string,
    line: number,
  ) =>
    issues.push({
      id,
      severity,
      title,
      detail,
      line,
      snippet: (lines[line - 1] ?? "").trim().slice(0, 160),
    });

  for (const l of linesOf(/\btx\.origin\b/))
    issue(
      "tx-origin",
      "high",
      "tx.origin used",
      "Checking tx.origin for authorization lets any contract the owner interacts with act as the owner. Use msg.sender.",
      l,
    );

  for (const m of src.matchAll(
    /(^|[;{}\n])\s*([^;{}\n]*\.(call|send|delegatecall)\s*(\{[^}]*\})?\s*\([^;]*\))\s*;/g,
  )) {
    const stmt = m[2]!;
    if (
      /^\s*(\(|bool\b|return\b|require\b|if\b|\w+\s*=)/.test(stmt) ||
      /=\s*[^=]/.test(stmt.split(".")[0]!)
    )
      continue;
    issue(
      "unchecked-call",
      "medium",
      `Unchecked ${m[3]}`,
      `The result of this low-level ${m[3]} isn't checked: if it fails, the code carries on as if it worked.`,
      at(m.index! + m[0].indexOf(stmt)),
    );
  }

  for (const f of fns) {
    const call = /\.call\s*\{\s*value\s*:/.exec(f.body) ?? /\.(transfer|send)\s*\(/.exec(f.body);
    if (!call || /\bnonReentrant\b/.test(f.header)) continue;
    const after = f.body.slice(call.index + call[0].length);
    if (
      /\b\w+\s*\[[^\]]+\](\s*\[[^\]]+\])?\s*(=|\+=|-=)(?!=)/.test(after) &&
      /\.call\s*\{\s*value/.test(call[0])
    )
      issue(
        "reentrancy",
        "high",
        "Possible reentrancy",
        `${f.name}() sends ETH and then updates storage. A malicious receiver can call back in before the update. Update state first, or add nonReentrant.`,
        lineOf(src, f.bodyStart + call.index),
      );
  }

  for (const l of linesOf(
    /keccak256\s*\(\s*abi\.encodePacked\s*\([^)]*\b(block\.(timestamp|difficulty|prevrandao|number)|blockhash)\b/,
  ))
    issue(
      "weak-randomness",
      "medium",
      "Predictable randomness",
      "Block values can be predicted or nudged by validators: don't use them for anything worth winning.",
      l,
    );

  const pragma = /pragma\s+solidity\s+([^;]+);/.exec(source);
  if (pragma) {
    const v = pragma[1]!;
    const minor = /0\.(\d+)/.exec(v);
    if (minor && Number(minor[1]) < 8)
      issue(
        "old-compiler",
        "medium",
        "Solidity before 0.8",
        `pragma solidity ${v}: arithmetic doesn't revert on overflow. Use 0.8 or newer, or SafeMath everywhere.`,
        lineOf(source, pragma.index),
      );
    else if (/[\^>]/.test(v))
      issue(
        "floating-pragma",
        "info",
        "Floating pragma",
        `pragma solidity ${v}: pin an exact version so what you test is what you deploy.`,
        lineOf(source, pragma.index),
      );
  }

  const asm = linesOf(/\bassembly\s*(\("[^"]*"\)\s*)?\{/);
  if (asm.length)
    issue(
      "assembly",
      "info",
      "Inline assembly",
      "Assembly skips Solidity's safety checks; read these blocks by hand.",
      asm[0]!,
    );

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  const verdict = checks.some((c) => c.status === "risk")
    ? "risky"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "clean";
  return { file, contracts, checks, issues, verdict };
}

/**
 * Turns a wallet request (eth_sendTransaction, typed-data signatures, eth_sign…) into plain
 * English and a list of findings. Pure and local: no network, works on any chain. The background
 * worker adds on-chain checks (is the spender a contract? what can the token do?) for
 * Robinhood Chain.
 */

export type Level = "risk" | "warn" | "info" | "ok";

export interface Finding {
  level: Level;
  text: string;
}

export type Kind =
  | "approval"
  | "approval-all"
  | "permit"
  | "transfer"
  | "send"
  | "blind-sign"
  | "call"
  | "listing"
  | "unknown";

export interface Analysis {
  kind: Kind;
  title: string;
  /** Plain-English lines describing what the request does. */
  lines: string[];
  findings: Finding[];
  /** Token contract involved (approvals, permits, transfers). */
  token: string | null;
  /** Who gets permission (approvals, permits). */
  spender: string | null;
  /** Contract being called, for other contract calls. */
  target: string | null;
  unlimited: boolean;
  /** Whether Mofu Guard should stop and show the request before it goes to the wallet. */
  prompt: boolean;
}

export const ROBINHOOD_CHAIN_ID = 4663;

/** Methods Mofu Guard looks at; everything else goes straight to the wallet. */
export const WATCHED = new Set([
  "eth_sendTransaction",
  "wallet_sendCalls",
  "eth_signTypedData_v4",
  "eth_signTypedData_v3",
  "eth_signTypedData",
  "eth_sign",
]);

const SEL = {
  approve: "095ea7b3",
  increaseAllowance: "39509351",
  setApprovalForAll: "a22cb465",
  transfer: "a9059cbb",
  transferFrom: "23b872dd",
  safeTransferFrom: "42842e0e",
  permit2Approve: "87517c45",
};

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
export const short = (a: string | null | undefined) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? "");

function word(data: string, i: number): string {
  return data.slice(8 + i * 64, 8 + (i + 1) * 64);
}
const addr = (w: string) => (w.length === 64 ? `0x${w.slice(24)}` : "");
const uint = (w: string) => (w.length === 64 ? BigInt(`0x${w}`) : 0n);

function toBig(v: unknown): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim());
  } catch {
    // not a number
  }
  return 0n;
}

/** Huge allowances are "unlimited" in practice, including the uint160 max that Permit2 uses. */
export const isUnlimited = (v: bigint) => v >= MAX_UINT256 / 2n || v >= MAX_UINT160 - 1n;

const amountText = (v: bigint) =>
  isUnlimited(v) ? "an unlimited amount" : `${v.toString()} base units`;

function ethValue(v: unknown): string | null {
  const wei = toBig(v);
  if (wei === 0n) return null;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ETH`;
}

const base = (kind: Kind, title: string): Analysis => ({
  kind,
  title,
  lines: [],
  findings: [],
  token: null,
  spender: null,
  target: null,
  unlimited: false,
  prompt: false,
});

/** One contract call: { to, data, value }. */
export function analyzeCall(tx: {
  to?: unknown;
  data?: unknown;
  input?: unknown;
  value?: unknown;
}): Analysis {
  const to = lower(tx.to);
  const data = lower(tx.data ?? tx.input).replace(/^0x/, "");
  const value = ethValue(tx.value);
  const sel = data.slice(0, 8);

  if (!data || data.length < 8) {
    const a = base("send", value ? `Send ${value}` : "Send a transaction");
    a.lines.push(
      value
        ? `Sends ${value} to ${short(to)}.`
        : `Sends a transaction to ${short(to)} with no data.`,
    );
    a.target = to || null;
    return a;
  }

  if (sel === SEL.approve || sel === SEL.increaseAllowance) {
    const spender = addr(word(data, 0));
    const amount = uint(word(data, 1));
    const a = base("approval", amount === 0n ? "Remove an approval" : "Approve token spending");
    a.token = to;
    a.spender = spender;
    a.unlimited = isUnlimited(amount);
    if (amount === 0n && sel === SEL.approve) {
      a.lines.push(
        `Sets the allowance of ${short(spender)} on token ${short(to)} back to 0. This removes a permission.`,
      );
      a.findings.push({
        level: "ok",
        text: "Revoking an approval is safe: it takes permission away.",
      });
      return a;
    }
    a.lines.push(
      `Lets ${short(spender)} move ${amountText(amount)} of token ${short(to)} from your wallet, whenever it wants.`,
    );
    a.findings.push(
      a.unlimited
        ? {
            level: "risk",
            text: "Unlimited approval: this spender can take ALL of this token from your wallet until you revoke it.",
          }
        : { level: "warn", text: "This gives another address permission to move your tokens." },
    );
    a.prompt = true;
    return a;
  }

  if (sel === SEL.setApprovalForAll) {
    const operator = addr(word(data, 0));
    const approved = uint(word(data, 1)) !== 0n;
    const a = base(
      "approval-all",
      approved ? "Approve ALL your NFTs in a collection" : "Remove a collection approval",
    );
    a.token = to;
    a.spender = operator;
    if (!approved) {
      a.lines.push(`Takes back ${short(operator)}'s permission over collection ${short(to)}.`);
      a.findings.push({ level: "ok", text: "Revoking is safe: it takes permission away." });
      return a;
    }
    a.unlimited = true;
    a.lines.push(
      `Lets ${short(operator)} move every item you own in collection ${short(to)}, now and later.`,
    );
    a.findings.push({
      level: "risk",
      text: "Approve-for-all hands over the whole collection. Only do this on a marketplace you trust.",
    });
    a.prompt = true;
    return a;
  }

  if (sel === SEL.permit2Approve) {
    const token = addr(word(data, 0));
    const spender = addr(word(data, 1));
    const amount = uint(word(data, 2));
    const a = base("approval", "Approve token spending through Permit2");
    a.token = token;
    a.spender = spender;
    a.unlimited = isUnlimited(amount);
    a.lines.push(
      `Through Permit2, lets ${short(spender)} move ${amountText(amount)} of token ${short(token)}.`,
    );
    a.findings.push(
      a.unlimited
        ? { level: "risk", text: "Unlimited Permit2 approval for this spender." }
        : { level: "warn", text: "This gives another address permission to move your tokens." },
    );
    a.prompt = true;
    return a;
  }

  if (sel === SEL.transfer) {
    const recipient = addr(word(data, 0));
    const a = base("transfer", "Send tokens");
    a.token = to;
    a.target = recipient;
    a.lines.push(
      `Sends ${uint(word(data, 1)).toString()} base units of token ${short(to)} to ${short(recipient)}.`,
    );
    return a;
  }

  if (sel === SEL.transferFrom || sel === SEL.safeTransferFrom) {
    const from = addr(word(data, 0));
    const recipient = addr(word(data, 1));
    const a = base("transfer", "Move tokens");
    a.token = to;
    a.target = recipient;
    a.lines.push(
      `Moves tokens or an item of ${short(to)} from ${short(from)} to ${short(recipient)}.`,
    );
    return a;
  }

  const a = base("call", "Call a contract");
  a.target = to || null;
  a.lines.push(`Calls contract ${short(to)}${value ? ` and sends ${value}` : ""}.`);
  return a;
}

interface TypedData {
  primaryType?: string;
  domain?: { name?: string; verifyingContract?: string; chainId?: unknown };
  message?: Record<string, unknown>;
}

/** Off-chain signatures that still move value: permits, Permit2 and marketplace listings. */
export function analyzeTypedData(raw: unknown): Analysis {
  let td: TypedData;
  try {
    td = (typeof raw === "string" ? JSON.parse(raw) : raw) as TypedData;
  } catch {
    const a = base("unknown", "Sign structured data");
    a.lines.push("A signature request Mofu couldn't read.");
    a.findings.push({
      level: "warn",
      text: "Mofu couldn't decode this. Only sign it if you know exactly what it is.",
    });
    a.prompt = true;
    return a;
  }
  const type = td.primaryType ?? "";
  const m = td.message ?? {};
  const domainName = td.domain?.name ?? "an app";
  const contract = lower(td.domain?.verifyingContract);

  if (type === "Permit") {
    const spender = lower(m.spender);
    const allowedDai = typeof m.allowed === "boolean" ? m.allowed : null;
    const value = allowedDai === null ? toBig(m.value) : allowedDai ? MAX_UINT256 : 0n;
    const a = base("permit", "Sign a token permit");
    a.token = contract || null;
    a.spender = spender;
    a.unlimited = isUnlimited(value);
    a.lines.push(
      `An off-chain signature for ${domainName}: lets ${short(spender)} move ${amountText(value)} of token ${short(contract)} from your wallet.`,
      "No transaction is sent now, but the spender can use this signature later without asking again.",
    );
    a.findings.push(
      a.unlimited
        ? {
            level: "risk",
            text: "Unlimited permit. This is a common way drainers take tokens without a transaction.",
          }
        : {
            level: "warn",
            text: "A permit signature gives spending permission, just like an approval.",
          },
    );
    a.prompt = true;
    return a;
  }

  if (type === "PermitSingle" || type === "PermitBatch") {
    const details = (Array.isArray(m.details) ? m.details : [m.details]) as Array<
      Record<string, unknown> | undefined
    >;
    const spender = lower(m.spender);
    const a = base("permit", "Sign a Permit2 approval");
    a.spender = spender;
    a.token = lower(details[0]?.token) || null;
    a.unlimited = details.some((d) => isUnlimited(toBig(d?.amount)));
    for (const d of details.slice(0, 5)) {
      a.lines.push(
        `Lets ${short(spender)} move ${amountText(toBig(d?.amount))} of token ${short(lower(d?.token))}.`,
      );
    }
    a.lines.push("Off-chain: the spender can use this later through the Permit2 contract.");
    a.findings.push(
      a.unlimited
        ? {
            level: "risk",
            text: "Unlimited Permit2 signature. Only sign this for an app you trust.",
          }
        : { level: "warn", text: "A Permit2 signature gives spending permission." },
    );
    a.prompt = true;
    return a;
  }

  if (
    type === "PermitTransferFrom" ||
    type === "PermitBatchTransferFrom" ||
    type === "PermitWitnessTransferFrom"
  ) {
    const permitted = (Array.isArray(m.permitted) ? m.permitted : [m.permitted]) as Array<
      Record<string, unknown> | undefined
    >;
    const spender = lower(m.spender);
    const a = base("permit", "Sign a token transfer");
    a.spender = spender;
    a.token = lower(permitted[0]?.token) || null;
    for (const p of permitted.slice(0, 5)) {
      a.lines.push(
        `Lets ${short(spender)} take ${amountText(toBig(p?.amount))} of token ${short(lower(p?.token))} in one go.`,
      );
    }
    a.findings.push({
      level: "warn",
      text: "This signature lets the spender pull tokens from your wallet. Check you meant to trade them.",
    });
    a.prompt = true;
    return a;
  }

  if (type === "OrderComponents" || type === "Order") {
    const a = base("listing", "Sign a marketplace order");
    a.lines.push(
      `An order for ${domainName}. It can list or sell your items at the price inside the order.`,
    );
    const consideration = Array.isArray(m.consideration) ? m.consideration : [];
    if (
      consideration.length === 0 ||
      consideration.every((c) => toBig((c as Record<string, unknown>)?.startAmount) === 0n)
    ) {
      a.findings.push({
        level: "risk",
        text: "This order asks for nothing in return: your items could be taken for free.",
      });
    } else {
      a.findings.push({
        level: "warn",
        text: "Check the price and the items in your wallet's details before signing.",
      });
    }
    a.prompt = true;
    return a;
  }

  const a = base("unknown", `Sign "${type || "data"}" for ${domainName}`);
  a.lines.push(
    `A structured signature for ${domainName}${contract ? ` (contract ${short(contract)})` : ""}.`,
  );
  a.findings.push({
    level: "info",
    text: "Mofu doesn't know this signature type. It's often a login or an order; read your wallet's details.",
  });
  return a;
}

/** Entry point: any watched request. */
export function analyzeRequest(method: string, params: unknown[]): Analysis[] {
  if (method === "eth_sendTransaction")
    return [analyzeCall((params[0] ?? {}) as Record<string, unknown>)];
  if (method === "wallet_sendCalls") {
    const calls = ((params[0] as { calls?: unknown[] } | undefined)?.calls ?? []) as Array<
      Record<string, unknown>
    >;
    return calls.slice(0, 10).map(analyzeCall);
  }
  if (method.startsWith("eth_signTypedData")) {
    // v3/v4: [address, data]; the legacy form is [data, address].
    const raw =
      typeof params[1] === "string" || typeof params[1] === "object" ? params[1] : params[0];
    return [analyzeTypedData(raw)];
  }
  if (method === "eth_sign") {
    const a = base("blind-sign", "Blind signature");
    a.lines.push(
      "Signs a raw hash you can't read. Whatever it stands for, your signature approves it.",
    );
    a.findings.push({
      level: "risk",
      text: "Blind signing can authorize anything, including moving all your tokens. Almost no honest app needs it.",
    });
    a.prompt = true;
    return [a];
  }
  return [];
}

/** Adds findings from the on-chain check (Robinhood Chain) and decides whether to prompt. */
export function enrich(
  a: Analysis,
  chain: {
    spender?: { address: string; isContract: boolean } | null;
    token?: {
      symbol: string | null;
      name: string | null;
      verdict: "clean" | "caution" | "risky";
      isContract: boolean;
      risks: string[];
    } | null;
  },
): Analysis {
  const out = { ...a, findings: [...a.findings] };
  if (
    chain.spender &&
    !chain.spender.isContract &&
    (a.kind === "approval" || a.kind === "approval-all" || a.kind === "permit")
  ) {
    out.findings.unshift({
      level: "risk",
      text: `The spender ${short(chain.spender.address)} is a plain wallet, not an app contract. That's a common sign of a drainer.`,
    });
    out.prompt = true;
  }
  if (chain.token) {
    const name = chain.token.symbol ?? chain.token.name ?? "This token";
    if (!chain.token.isContract) {
      out.findings.push({
        level: "warn",
        text: `${short(a.token)} isn't a contract on Robinhood Chain.`,
      });
    } else if (chain.token.verdict === "risky") {
      out.findings.push({
        level: "warn",
        text: `${name}'s contract gives someone strong control: ${chain.token.risks.slice(0, 2).join(" ")}`,
      });
      out.prompt = true;
    } else if (chain.token.verdict === "clean") {
      out.findings.push({
        level: "ok",
        text: `${name}'s contract has no red flags in Mofu's scan.`,
      });
    }
  }
  return out;
}

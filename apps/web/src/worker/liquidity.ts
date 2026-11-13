/**
 * Liquidity: where a token's liquidity sits and whether a wallet can take it out.
 *
 * - On a Pons launch curve: how much ETH it raised toward graduation, and whether the curve's code
 *   has any owner or withdraw function (it normally has none, so ETH leaves only through sells).
 * - Graduated: the Pons factory moved the liquidity into a Uniswap v4 pool at graduation.
 * - In a v2 pool: who holds the LP tokens (burned, held by contracts, held by wallets).
 * - v3 / v4 pools: the ETH side only; who owns the positions isn't read.
 * Deterministic; no model.
 */
import type {
  LiquidityInfo,
  SellTest,
  TokenCheck,
  TokenHolder,
  TokenOrigin,
} from "../shared/api.js";
import { callOf, rpcBatch, type BatchResult } from "./chain.js";
import { topHolders, type ChainDataOptions } from "./chain-data.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { PONS_LAUNCHPAD, V4_POOL_MANAGER, WETH } from "./known.js";

// Computed here rather than imported from token-scan, which imports this module.
const selector = (signature: string) =>
  Array.from(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Functions that would let someone take funds out of a launch curve. */
const ADMIN_SIGNATURES = [
  "owner()",
  "withdraw()",
  "withdraw(uint256)",
  "withdrawETH()",
  "withdrawAll()",
  "emergencyWithdraw()",
  "rescueETH()",
  "rescueTokens(address,uint256)",
  "sweep(address)",
  "setGraduationThreshold(uint256)",
];
const ADMIN = ADMIN_SIGNATURES.map((s) => [s, selector(s)] as const);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (h: BatchResult | undefined): bigint | null =>
  h && /^0x[0-9a-f]{1,64}/i.test(h) && h.length >= 3
    ? BigInt(h.length > 66 ? h.slice(0, 66) : h)
    : null;
const eth = (wei: bigint | null) => (wei === null ? null : Number(wei / 10n ** 12n) / 1_000_000);
const fmtEth = (n: number) =>
  n >= 100
    ? n.toFixed(0)
    : n >= 1
      ? Number(n.toFixed(2)).toString()
      : Number(n.toPrecision(2)).toString();
const pct = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 1_000_000n) / total) / 10_000 : 0;
const fmtPct = (n: number) => `${Number(n.toFixed(1))}%`;

/** What a Pons launch curve says about itself. Pure, from the batch answers. */
export function curveInfo(
  venue: string,
  answers: {
    graduated: BatchResult;
    threshold: BatchResult;
    balance: BatchResult;
    code: BatchResult;
  },
): LiquidityInfo {
  const code = (answers.code ?? "").toLowerCase();
  const adminFunctions = ADMIN.filter(([, s]) => code.includes(`63${s}`)).map(([sig]) => sig);
  const graduated = word(answers.graduated);
  const threshold = word(answers.threshold);
  const balance = word(answers.balance);
  if (graduated !== null && graduated !== 0n) {
    return {
      kind: "graduated",
      venue,
      eth: null,
      curve: null,
      lp: null,
      status: "info",
      detail:
        "It graduated: the Pons factory moved its liquidity from the launch curve into a Uniswap v4 pool, not a wallet. Who can remove that v4 position isn't checked yet.",
    };
  }
  // A curve priced in ETH holds ETH; one priced in another token holds none.
  const inEth = balance !== null && balance > 0n;
  const raised = inEth ? eth(balance) : null;
  const goal = inEth ? eth(threshold) : null;
  const progress =
    inEth && threshold && threshold > 0n
      ? Math.min(100, Number((balance! * 1000n) / threshold) / 10)
      : null;
  const toGo =
    raised !== null && goal !== null && progress !== null
      ? ` ${fmtEth(raised)} of the ${fmtEth(goal)} ETH it needs to graduate is raised (${fmtPct(progress)}).`
      : "";
  const status: LiquidityInfo["status"] = adminFunctions.length ? "warn" : "ok";
  return {
    kind: "curve",
    venue,
    eth: raised,
    curve: { raised, threshold: goal, progressPercent: progress, adminFunctions },
    lp: null,
    status,
    detail: adminFunctions.length
      ? `It's on a launch curve whose code has admin functions (${adminFunctions.join(", ")}), so someone may be able to change it or take funds out.${toGo}`
      : `No. It's still on the Pons launch curve, which has no owner or withdraw function: ETH leaves it only through sells.${toGo}`,
  };
}

/** A v2 pool's LP ownership. Pure. */
export function v2Info(
  venue: string,
  ethWei: bigint | null,
  lpSupply: bigint | null,
  burned: bigint,
  holders: TokenHolder[] | null,
): LiquidityInfo {
  const ethSide = eth(ethWei);
  const burnedPercent = lpSupply ? pct(burned, lpSupply) : 0;
  let contractPercent: number | null = null;
  let walletPercent: number | null = null;
  let topWallet: { address: string; percent: number } | null = null;
  if (holders && holders.length) {
    contractPercent = holders
      .filter((h) => h.kind === "contract")
      .reduce((n, h) => n + h.percent, 0);
    walletPercent = holders.filter((h) => h.kind === "wallet").reduce((n, h) => n + h.percent, 0);
    const w = holders.find((h) => h.kind === "wallet");
    topWallet = w ? { address: w.address, percent: w.percent } : null;
  }
  const where = `${ethSide !== null ? `${fmtEth(ethSide)} ETH in ` : ""}a v2 pool (${short(venue)})`;
  let status: LiquidityInfo["status"];
  let detail: string;
  if (topWallet && topWallet.percent >= 50) {
    status = "risk";
    detail = `Yes. One wallet (${short(topWallet.address)}) holds ${fmtPct(topWallet.percent)} of the LP tokens for ${where} and can remove that share of the liquidity at any time.`;
  } else if (walletPercent !== null && walletPercent >= 10) {
    status = "warn";
    detail = `Partly. Wallets hold ${fmtPct(walletPercent)} of the LP tokens for ${where} and can remove that share at any time.${burnedPercent ? ` ${fmtPct(burnedPercent)} is burned.` : ""}`;
  } else if (walletPercent !== null) {
    status = "ok";
    detail = `Mostly not. ${fmtPct(burnedPercent)} of the LP tokens for ${where} are burned${contractPercent ? ` and ${fmtPct(contractPercent)} sit in contracts (often lockers or farms; Mofu can't tell for how long)` : ""}.`;
  } else {
    status = burnedPercent >= 90 ? "ok" : "info";
    detail =
      burnedPercent >= 90
        ? `Mostly not. ${fmtPct(burnedPercent)} of the LP tokens for ${where} are burned.`
        : `It trades in ${where}; ${fmtPct(burnedPercent)} of the LP tokens are burned. Who holds the rest couldn't be read.`;
  }
  return {
    kind: "v2",
    venue,
    eth: ethSide,
    curve: null,
    lp: { burnedPercent, contractPercent, walletPercent, topWallet },
    status,
    detail,
  };
}

/** Reads where the liquidity is. Null when there's no venue to look at. Never throws. */
export async function readLiquidity(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  ctx: {
    holders: readonly TokenHolder[];
    sold: SellTest | null;
    origin: TokenOrigin | null;
    data?: ChainDataOptions;
  },
): Promise<LiquidityInfo | null> {
  try {
    const { sold, holders, origin, data } = ctx;
    if (sold?.method === "curve") {
      const c = sold.venue.toLowerCase();
      const [graduated, threshold, , balance, code] = await rpcBatch(
        urls,
        [
          callOf(c, "0xe7c2b772"),
          callOf(c, "0x8b0bc501"),
          callOf(c, "0xc45a0155"),
          { method: "eth_getBalance", params: [c, "latest"] },
          { method: "eth_getCode", params: [c, "latest"] },
        ],
        fetchFn,
      );
      return curveInfo(c, {
        graduated: graduated ?? null,
        threshold: threshold ?? null,
        balance: balance ?? null,
        code: code ?? null,
      });
    }
    // The pool the sell test used; without one, a v2/v3 pair among the top holders.
    let pool = sold?.method === "transfer" ? sold.venue.toLowerCase() : null;
    if (!pool) {
      const candidates = holders
        .filter((h) => h.kind === "contract" && h.address !== V4_POOL_MANAGER)
        .slice(0, 4);
      const pairs = await rpcBatch(
        urls,
        candidates.flatMap((h) => [
          callOf(h.address, "0x0dfe1681"),
          callOf(h.address, "0xd21220a7"),
        ]),
        fetchFn,
      ).catch(() => candidates.flatMap(() => [null, null]));
      const t = token.toLowerCase();
      const at = (h: BatchResult | undefined) =>
        h && /^0x0{24}[0-9a-f]{40}/i.test(h) ? `0x${h.slice(26, 66)}`.toLowerCase() : null;
      pool =
        candidates.find((_, i) => at(pairs[i * 2]) === t || at(pairs[i * 2 + 1]) === t)?.address ??
        null;
    }
    if (pool) {
      const [reserves, slot0, wethBal, lpSupply, dead, zero] = await rpcBatch(
        urls,
        [
          callOf(pool, "0x0902f1ac"),
          callOf(pool, "0x3850c7bd"),
          callOf(WETH, `0x70a08231${pad(pool)}`),
          callOf(pool, "0x18160ddd"),
          callOf(pool, `0x70a08231${pad(DEAD)}`),
          callOf(pool, `0x70a08231${pad(ZERO)}`),
        ],
        fetchFn,
      );
      const ethWei = word(wethBal);
      if (reserves && reserves.length > 2) {
        const lp = data ? await topHolders(data, pool, 10).catch(() => null) : null;
        return v2Info(pool, ethWei, word(lpSupply), (word(dead) ?? 0n) + (word(zero) ?? 0n), lp);
      }
      if (slot0 && slot0.length > 2) {
        const e = eth(ethWei);
        return {
          kind: "v3",
          venue: pool,
          eth: e,
          curve: null,
          lp: null,
          status: "info",
          detail: `It trades in a Uniswap v3-style pool (${short(pool)})${e !== null && e > 0 ? ` with ${fmtEth(e)} ETH on the ETH side` : ""}. v3 liquidity sits in positions their owners can remove; who owns them isn't checked yet.`,
        };
      }
    }
    if (holders.some((h) => h.address === V4_POOL_MANAGER)) {
      const pons = origin?.launcher === PONS_LAUNCHPAD;
      return {
        kind: pons ? "graduated" : "v4",
        venue: V4_POOL_MANAGER,
        eth: null,
        curve: null,
        lp: null,
        status: "info",
        detail: pons
          ? "It graduated: the Pons factory moved its liquidity from the launch curve into a Uniswap v4 pool, not a wallet. Who can remove that v4 position isn't checked yet."
          : "It trades in a Uniswap v4 pool. v4 liquidity sits in positions their owners can remove; who owns them isn't checked yet.",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const liquidityCheck = (l: LiquidityInfo): TokenCheck => ({
  id: "liquidity",
  label: "Can the liquidity be pulled?",
  status: l.status,
  detail: l.detail,
});

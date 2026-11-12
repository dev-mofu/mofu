/**
 * Sell Test: simulates a small buy and an immediate sell with eth_simulateV1, so nothing is sent
 * and no wallet is involved. A made-up address gets 1 ETH of simulated balance.
 *
 * - On a Pons launch curve it runs the real thing: buy for 0.001 ETH, approve, sell everything.
 *   Native ETH movements are traced, so the round trip (what comes back) is exact.
 * - Elsewhere it moves tokens the way a pool swap does: the pool sends tokens to the test address
 *   (a buy), then the test address sends them back (a sell). Taxes show up as missing tokens.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { SellDepth, SellTest, TokenHolder } from "../shared/api.js";
import { callOf, rpcBatch, rpcCall } from "./chain.js";
import { WETH } from "./known.js";

/** "mofuselltest" in hex: a fresh address nobody controls. */
export const TESTER = "0x6d6f667573656c6c746573740000000000000001";
const ETH_IN = 10n ** 15n; // 0.001 ETH
const MAX = (1n << 256n) - 1n;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** eth_simulateV1 reports native ETH moves as Transfer logs from this pseudo-address. */
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const pad = (v: bigint | string) =>
  (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const hex = (v: bigint) => `0x${v.toString(16)}`;

interface SimLog {
  address: string;
  topics: string[];
  data: string;
}
interface SimCall {
  status?: string;
  returnData?: string;
  logs?: SimLog[];
  error?: { message?: string };
}

interface Move {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

function moves(call: SimCall | undefined): Move[] {
  return (call?.logs ?? [])
    .filter((l) => l.topics?.[0] === TRANSFER_TOPIC && l.topics.length >= 3)
    .map((l) => ({
      token: l.address.toLowerCase(),
      from: `0x${l.topics[1]!.slice(26)}`.toLowerCase(),
      to: `0x${l.topics[2]!.slice(26)}`.toLowerCase(),
      value: l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n,
    }));
}

const ok = (c: SimCall | undefined) => !!c && c.status === "0x1";

/** Share lost between what left and what arrived, 0–100, two decimals. */
const lost = (sent: bigint, got: bigint) =>
  sent > 0n ? Math.max(0, Number(((sent - got) * 10_000n) / sent) / 100) : null;

async function simulate(
  urls: readonly string[],
  fetchFn: typeof fetch,
  calls: Array<{ from: string; to: string; data: string; value?: bigint }>,
): Promise<SimCall[]> {
  const result = await rpcCall<Array<{ calls?: SimCall[] }>>(
    urls,
    "eth_simulateV1",
    [
      {
        blockStateCalls: [
          {
            stateOverrides: { [TESTER]: { balance: hex(10n ** 18n) } },
            calls: calls.map((c) => ({
              from: c.from,
              to: c.to,
              data: c.data,
              ...(c.value ? { value: hex(c.value) } : {}),
              gas: hex(3_000_000n),
            })),
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ],
    fetchFn,
    15_000,
  );
  return result?.[0]?.calls ?? [];
}

const pct = (n: number | null) => (n === null ? "unknown" : `${n}%`);

// ---------------------------------------------------------------- sell depth

/** Price drop that counts as "the most one sale can take". */
const DEPTH_IMPACT = 10;
/** Sell sizes tried on a curve, as shares of the total supply (percent). The first is the baseline. */
const DEPTH_STEPS = [0.001, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];
/** EIP-7201 slot of OpenZeppelin v5's upgradeable ERC20 balances. */
const OZ5_BALANCES = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

const toHex = (b: Uint8Array) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
const balanceKey = (holder: string, slot: bigint) => {
  const bytes = new Uint8Array(64);
  const words = pad(holder) + pad(slot);
  for (let i = 0; i < 64; i++) bytes[i] = Number.parseInt(words.slice(i * 2, i * 2 + 2), 16);
  return toHex(keccak_256(bytes));
};
const eth = (wei: bigint) => Number(wei) / 1e18;
const round = (n: number, d = 4) => Number(n.toPrecision(d));

export function depthDetail(d: SellDepth): string {
  const how =
    d.method === "simulated" ? "simulated sells on the launch curve" : "the pool's reserves";
  if (d.ethAt10Percent === null)
    return `Sell depth: even a small sale moves the price more than ${DEPTH_IMPACT}% (from ${how}).`;
  return d.moreThan
    ? `Sell depth: a sale of more than ${d.ethAt10Percent} ETH moves the price less than ${DEPTH_IMPACT}% (from ${how}).`
    : `Sell depth: one sale of about ${d.ethAt10Percent} ETH moves the price ${DEPTH_IMPACT}% (from ${how}).`;
}

/**
 * How big one sale can be before the price drops 10%, on a launch curve. The test address is
 * given tokens by overriding the token's balance storage (found by trying the usual slots), then
 * sells of growing size are simulated from the current state. Two batched requests.
 */
export async function curveDepth(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  curve: string,
): Promise<SellDepth | null> {
  const slots = [...Array.from({ length: 10 }, (_, i) => BigInt(i)), OZ5_BALANCES];
  const MARK = 123_456_789n;
  const probe = await rpcBatch(
    urls,
    [
      callOf(token, "0x18160ddd"),
      ...slots.map((s) => ({
        method: "eth_call",
        params: [
          { to: token, data: `0x70a08231${pad(TESTER)}` },
          "latest",
          { [token]: { stateDiff: { [balanceKey(TESTER, s)]: `0x${pad(MARK)}` } } },
        ],
      })),
    ],
    fetchFn,
  );
  const supply = probe[0] ? BigInt(probe[0].slice(0, 66)) : 0n;
  const at = probe
    .slice(1)
    .findIndex((r) => !!r && r.length >= 66 && BigInt(r.slice(0, 66)) === MARK);
  if (supply === 0n || at < 0) return null;
  const slot = slots[at]!;
  const sizes = DEPTH_STEPS.map((p) => (supply * BigInt(Math.round(p * 1000))) / 100_000n);
  const sims = sizes.map((amount) => ({
    method: "eth_simulateV1",
    params: [
      {
        blockStateCalls: [
          {
            stateOverrides: {
              [TESTER]: { balance: hex(10n ** 18n) },
              [token]: { stateDiff: { [balanceKey(TESTER, slot)]: `0x${pad(amount)}` } },
            },
            calls: [
              {
                from: TESTER,
                to: token,
                data: `0x095ea7b3${pad(curve)}${pad(MAX)}`,
                gas: hex(3_000_000n),
              },
              {
                from: TESTER,
                to: curve,
                data: `0xd04c6983${pad(amount)}${pad(0n)}${pad(TESTER)}`,
                gas: hex(3_000_000n),
              },
            ],
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ],
  }));
  // rpcBatch hands back only string results; eth_simulateV1 answers with objects, so post directly.
  const answers = await batchObjects(urls, sims, fetchFn);
  if (!answers) return null;
  const out = answers.map((a) => {
    const call = (a as Array<{ calls?: SimCall[] }> | null)?.[0]?.calls?.[1];
    if (!ok(call)) return null;
    return moves(call)
      .filter((m) => m.token === NATIVE && m.to === TESTER)
      .reduce((n, m) => n + m.value, 0n);
  });
  const base = out[0];
  if (!base || base === 0n) return null;
  // price per token unit, as a float: fine for a percentage
  const p0 = Number(base) / Number(sizes[0]!);
  const steps = sizes.slice(1).map((amount, i) => {
    const got = out[i + 1];
    const impact = got ? Math.max(0, 1 - Number(got) / Number(amount) / p0) * 100 : 100;
    return {
      supplyPercent: DEPTH_STEPS[i + 1]!,
      ethOut: got ? round(eth(got)) : 0,
      impactPercent: round(impact, 3),
    };
  });
  return depthFrom(steps, "simulated");
}

function depthFrom(steps: SellDepth["steps"], method: SellDepth["method"]): SellDepth {
  const i = steps.findLastIndex((s) => s.impactPercent <= DEPTH_IMPACT);
  const best = i >= 0 ? steps[i]! : null;
  const next = i >= 0 ? steps[i + 1] : undefined;
  // Between the last size under 10% and the first one over it, the 10% point is interpolated.
  let at10 = best ? best.ethOut : null;
  if (best && next && next.ethOut > 0 && next.impactPercent > best.impactPercent) {
    const f = (DEPTH_IMPACT - best.impactPercent) / (next.impactPercent - best.impactPercent);
    at10 = round(best.ethOut + (next.ethOut - best.ethOut) * f, 2);
  } else if (at10 !== null) at10 = round(at10, 2);
  const d: SellDepth = {
    method,
    ethAt10Percent: at10,
    moreThan: best !== null && best === steps.at(-1),
    steps,
    detail: "",
  };
  return { ...d, detail: depthDetail(d) };
}

/** A V2-style pool paired with WETH: the 10% point from its reserves (0.3% fee assumed). */
export async function poolDepth(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  pool: string,
): Promise<SellDepth | null> {
  const [t0, t1, reserves] = await rpcBatch(
    urls,
    [callOf(pool, "0x0dfe1681"), callOf(pool, "0xd21220a7"), callOf(pool, "0x0902f1ac")],
    fetchFn,
  );
  const addr = (h: string | null | undefined) =>
    h && h.length >= 66 ? `0x${h.slice(26, 66)}`.toLowerCase() : null;
  if (!reserves || reserves.length < 2 + 64 * 2) return null;
  const r0 = BigInt(`0x${reserves.slice(2, 66)}`);
  const r1 = BigInt(`0x${reserves.slice(66, 130)}`);
  const [a0, a1] = [addr(t0), addr(t1)];
  const tokenIs0 = a0 === token && a1 === WETH;
  const tokenIs1 = a1 === token && a0 === WETH;
  if (!tokenIs0 && !tokenIs1) return null;
  const rt = tokenIs0 ? r0 : r1;
  const re = tokenIs0 ? r1 : r0;
  if (rt === 0n || re === 0n) return null;
  // Selling a tokens returns a·997·re / (1000·rt + 997·a); the average price is 10% under the
  // spot price at a = 1000·rt·0.1 / (997·0.9).
  const a = (rt * 1000n * 10n) / (997n * 90n);
  const out = (a * 997n * re) / (rt * 1000n + a * 997n);
  return depthFrom(
    [{ supplyPercent: null, ethOut: round(eth(out)), impactPercent: DEPTH_IMPACT }],
    "reserves",
  );
}

/** A JSON-RPC batch whose results are objects (eth_simulateV1). Null when no endpoint takes it. */
async function batchObjects(
  urls: readonly string[],
  calls: Array<{ method: string; params: unknown[] }>,
  fetchFn: typeof fetch,
): Promise<unknown[] | null> {
  const body = calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }));
  for (const url of urls) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const answers = (await res.json()) as Array<{
        id?: number;
        result?: unknown;
        error?: unknown;
      }>;
      if (!Array.isArray(answers) || answers.length !== calls.length) continue;
      const out: unknown[] = new Array(calls.length).fill(null);
      for (const a of answers)
        if (typeof a.id === "number" && !a.error) out[a.id] = a.result ?? null;
      return out;
    } catch {
      // next endpoint
    }
  }
  return null;
}

async function curveTest(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  curve: string,
): Promise<SellTest | null> {
  const buy = {
    from: TESTER,
    to: curve,
    value: ETH_IN,
    data: `0x59a87bc1${pad(ETH_IN)}${pad(0n)}${pad(TESTER)}`,
  };
  const first = await simulate(urls, fetchFn, [buy]);
  if (!ok(first[0])) return null; // curve closed (graduated) or a different design
  const bought = moves(first[0]).filter((m) => m.token === token);
  const sentByCurve = bought.filter((m) => m.from === curve).reduce((n, m) => n + m.value, 0n);
  const got = bought.filter((m) => m.to === TESTER).reduce((n, m) => n + m.value, 0n);
  if (got === 0n) return null;
  const [, , sell] = await simulate(urls, fetchFn, [
    buy,
    { from: TESTER, to: token, data: `0x095ea7b3${pad(curve)}${pad(MAX)}` },
    { from: TESTER, to: curve, data: `0xd04c6983${pad(got)}${pad(0n)}${pad(TESTER)}` },
  ]);
  const buyTax = lost(sentByCurve, got);
  if (!ok(sell)) {
    return {
      status: "failed",
      method: "curve",
      venue: curve,
      buyTaxPercent: buyTax,
      sellTaxPercent: null,
      roundTripPercent: null,
      depth: null,
      detail: `No. A simulated buy on the launch curve worked, but selling the tokens back failed${sell?.error?.message ? ` (${sell.error.message.slice(0, 120)})` : ""}.`,
    };
  }
  const sold = moves(sell).filter((m) => m.token === token);
  const out = sold.filter((m) => m.from === TESTER).reduce((n, m) => n + m.value, 0n);
  const arrived = sold.filter((m) => m.to === curve).reduce((n, m) => n + m.value, 0n);
  const ethBack = moves(sell)
    .filter((m) => m.token === NATIVE && m.to === TESTER)
    .reduce((n, m) => n + m.value, 0n);
  const sellTax = lost(out, arrived);
  const roundTrip = Number((ethBack * 10_000n) / ETH_IN) / 100;
  const depth = await curveDepth(urls, fetchFn, token, curve).catch(() => null);
  return {
    status: "passed",
    method: "curve",
    venue: curve,
    buyTaxPercent: buyTax,
    sellTaxPercent: sellTax,
    roundTripPercent: roundTrip,
    depth,
    detail: `Yes. Mofu simulated buying for 0.001 ETH on the launch curve and selling straight back: it went through, and ${roundTrip}% of the ETH came back (curve fees and price movement included). Token tax on the buy: ${pct(buyTax)}, on the sell: ${pct(sellTax)}.${depth ? ` ${depth.detail}` : ""}`,
  };
}

async function transferTest(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  pool: string,
  poolBalance: bigint,
): Promise<SellTest | null> {
  const amount = poolBalance / 10_000n;
  if (amount === 0n) return null;
  const [inCall] = await simulate(urls, fetchFn, [
    { from: pool, to: token, data: `0xa9059cbb${pad(TESTER)}${pad(amount)}` },
  ]);
  if (!ok(inCall)) return null; // the pool can't move tokens this way; nothing to conclude
  const inMoves = moves(inCall).filter((m) => m.token === token);
  const got = inMoves.filter((m) => m.to === TESTER).reduce((n, m) => n + m.value, 0n);
  if (got === 0n) return null;
  const [, outCall] = await simulate(urls, fetchFn, [
    { from: pool, to: token, data: `0xa9059cbb${pad(TESTER)}${pad(amount)}` },
    { from: TESTER, to: token, data: `0xa9059cbb${pad(pool)}${pad(got)}` },
  ]);
  const buyTax = lost(amount, got);
  if (!ok(outCall)) {
    return {
      status: "failed",
      method: "transfer",
      venue: pool,
      buyTaxPercent: buyTax,
      sellTaxPercent: null,
      roundTripPercent: null,
      depth: null,
      detail: `No. Tokens could move from the pool to a new wallet (a buy), but sending them back to the pool (a sell) failed${outCall?.error?.message ? ` (${outCall.error.message.slice(0, 120)})` : ""}.`,
    };
  }
  const arrived = moves(outCall)
    .filter((m) => m.token === token && m.to === pool)
    .reduce((n, m) => n + m.value, 0n);
  const sellTax = lost(got, arrived);
  const depth = await poolDepth(urls, fetchFn, token, pool).catch(() => null);
  return {
    status: "passed",
    method: "transfer",
    venue: pool,
    buyTaxPercent: buyTax,
    sellTaxPercent: sellTax,
    roundTripPercent: null,
    depth,
    detail: `Yes. Mofu simulated tokens moving from the pool to a new wallet and back, the way a buy and a sell do: both went through. Tax on the buy: ${pct(buyTax)}, on the sell: ${pct(sellTax)}.${depth ? ` ${depth.detail}` : ""}`,
  };
}

/**
 * Finds where the token trades among its top holders (a Pons curve, else a pool) and tests a buy
 * and a sell there. Null when there's nowhere to test or the chain can't simulate.
 */
export async function sellTest(
  urls: readonly string[],
  fetchFn: typeof fetch,
  token: string,
  holders: readonly TokenHolder[],
  decimals: number,
): Promise<SellTest | null> {
  const contracts = holders.filter((h) => h.kind === "contract").slice(0, 6);
  if (contracts.length === 0) return null;
  const r = await rpcBatch(
    urls,
    contracts.flatMap((h) => [
      { method: "eth_getCode", params: [h.address, "latest"] },
      callOf(h.address, "0xfc0c546a"),
      callOf(h.address, "0x0dfe1681"),
      callOf(h.address, "0xd21220a7"),
    ]),
    fetchFn,
  );
  const addr = (h: string | null | undefined) =>
    h && /^0x0{24}[0-9a-f]{40}/i.test(h) ? `0x${h.slice(26, 66)}`.toLowerCase() : null;
  try {
    for (let i = 0; i < contracts.length; i++) {
      const [code, t, t0, t1] = r.slice(i * 4, i * 4 + 4);
      const h = contracts[i]!;
      if (
        addr(t) === token &&
        ["59a87bc1", "d04c6983"].every((s) => (code ?? "").includes(`63${s}`))
      ) {
        const res = await curveTest(urls, fetchFn, token, h.address);
        if (res) return res;
      }
      if (addr(t0) === token || addr(t1) === token) {
        const units = BigInt(h.balance) * 10n ** BigInt(decimals);
        const res = await transferTest(urls, fetchFn, token, h.address, units);
        if (res) return res;
      }
    }
  } catch {
    return null;
  }
  return null;
}

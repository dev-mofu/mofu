/**
 * Sell Test: simulates a small buy and an immediate sell with eth_simulateV1, so nothing is sent
 * and no wallet is involved. A made-up address gets 1 ETH of simulated balance.
 *
 * - On a Pons launch curve it runs the real thing: buy for 0.001 ETH, approve, sell everything.
 *   Native ETH movements are traced, so the round trip (what comes back) is exact.
 * - Elsewhere it moves tokens the way a pool swap does: the pool sends tokens to the test address
 *   (a buy), then the test address sends them back (a sell). Taxes show up as missing tokens.
 */
import type { SellTest, TokenHolder } from "../shared/api.js";
import { callOf, rpcBatch, rpcCall } from "./chain.js";

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
  return {
    status: "passed",
    method: "curve",
    venue: curve,
    buyTaxPercent: buyTax,
    sellTaxPercent: sellTax,
    roundTripPercent: roundTrip,
    detail: `Yes. Mofu simulated buying for 0.001 ETH on the launch curve and selling straight back: it went through, and ${roundTrip}% of the ETH came back (curve fees and price movement included). Token tax on the buy: ${pct(buyTax)}, on the sell: ${pct(sellTax)}.`,
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
      detail: `No. Tokens could move from the pool to a new wallet (a buy), but sending them back to the pool (a sell) failed${outCall?.error?.message ? ` (${outCall.error.message.slice(0, 120)})` : ""}.`,
    };
  }
  const arrived = moves(outCall)
    .filter((m) => m.token === token && m.to === pool)
    .reduce((n, m) => n + m.value, 0n);
  const sellTax = lost(got, arrived);
  return {
    status: "passed",
    method: "transfer",
    venue: pool,
    buyTaxPercent: buyTax,
    sellTaxPercent: sellTax,
    roundTripPercent: null,
    detail: `Yes. Mofu simulated tokens moving from the pool to a new wallet and back, the way a buy and a sell do: both went through. Tax on the buy: ${pct(buyTax)}, on the sell: ${pct(sellTax)}.`,
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

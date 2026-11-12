import { describe, expect, it } from "vitest";
import { findPoisoning, looksLike, type HistoryTx } from "../src/worker/poisoning.js";

const ME = "0xabcd000000000000000000000000000000004321";
const FRIEND = "0x1234567890abcdef1234567890abcdef12345678";
const FAKE_FRIEND = "0x1234ffffffffffffffffffffffffffffffff5678";
const FAKE_ME = "0xabcdeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee4321";
const STRANGER = "0x9999999999999999999999999999999999999999";
const SCAMMER = "0x7777777777777777777777777777777777777777";
const USDC = "0x5555555555555555555555555555555555555555";

const transfer = (from: string, to: string, value: string) => ({
  sender_address: USDC,
  sender_contract_ticker_symbol: "USDC",
  decoded: {
    name: "Transfer",
    params: [
      { name: "from", value: from },
      { name: "to", value: to },
      { name: "value", value },
    ],
  },
});

const history: HistoryTx[] = [
  // the wallet's real payment to a friend
  {
    tx_hash: "0x01",
    from_address: ME,
    to_address: USDC,
    value: "0",
    successful: true,
    log_events: [transfer(ME, FRIEND, "5000000")],
  },
  // a scammer sends dust from a lookalike of the friend
  {
    tx_hash: "0x02",
    block_signed_at: "2026-11-10T00:00:00Z",
    from_address: SCAMMER,
    to_address: USDC,
    value: "0",
    log_events: [transfer(FAKE_FRIEND, ME, "1")],
  },
  // a 0-token transferFrom "from" the wallet to a lookalike of the wallet itself
  {
    tx_hash: "0x03",
    from_address: SCAMMER,
    to_address: USDC,
    value: "0",
    log_events: [transfer(ME, FAKE_ME, "0")],
  },
  // an ordinary incoming payment from someone unrelated
  {
    tx_hash: "0x04",
    from_address: STRANGER,
    to_address: USDC,
    value: "0",
    log_events: [transfer(STRANGER, ME, "1000000")],
  },
  // a 0-token transfer from the wallet to an address that imitates nobody
  {
    tx_hash: "0x05",
    from_address: SCAMMER,
    to_address: USDC,
    value: "0",
    log_events: [transfer(ME, STRANGER, "0")],
  },
];

describe("address poisoning", () => {
  it("matches lookalikes by first and last four characters", () => {
    expect(looksLike(FAKE_FRIEND, FRIEND)).toBe(true);
    expect(looksLike(FRIEND, FRIEND)).toBe(false);
    expect(looksLike(STRANGER, FRIEND)).toBe(false);
  });

  it("flags planted lookalikes and unsent zero transfers, and nothing else", () => {
    const alerts = findPoisoning(ME, history);
    expect(alerts.map((a) => [a.address, a.risk, a.kind, a.resembles])).toEqual([
      [FAKE_FRIEND, "risk", "dust", FRIEND],
      [FAKE_ME, "risk", "zero-transfer", ME],
      [STRANGER, "warn", "zero-transfer", null],
    ]);
    expect(alerts[1]!.resemblesSelf).toBe(true);
    expect(alerts[0]).toMatchObject({
      txHash: "0x02",
      tokenSymbol: "USDC",
      at: "2026-11-10T00:00:00Z",
    });
  });

  it("ignores what the wallet sent itself and handles empty history", () => {
    expect(findPoisoning(ME, history.slice(0, 1))).toEqual([]);
    expect(findPoisoning(ME, [])).toEqual([]);
    expect(
      findPoisoning(ME, [{ tx_hash: "0x9", from_address: SCAMMER, log_events: null }]),
    ).toEqual([]);
  });
});

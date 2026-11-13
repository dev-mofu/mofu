import { describe, expect, it } from "vitest";
import type { TokenScanReport } from "../src/shared/api.js";
import type { TxItem } from "../src/worker/chain-data.js";
import { radarMain } from "../src/worker/pages.js";
import { launchesFrom, radarEntry, type RadarEntry } from "../src/worker/radar.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const CURVE = "0x3333333333333333333333333333333333333333";
const CREATOR = "0x4444444444444444444444444444444444444444";
const NOW = Date.parse("2026-11-13T12:00:00Z");

const mint = (token: string, to: string) => ({
  sender_address: token,
  decoded: {
    name: "Transfer",
    params: [
      { name: "from", value: ZERO },
      { name: "to", value: to },
      { name: "value", value: "1000" },
    ],
  },
});

describe("launchesFrom", () => {
  it("picks the tokens minted in the launcher's transactions, oldest first", () => {
    const txs: TxItem[] = [
      {
        block_signed_at: "2026-11-13T11:58:00Z",
        from_address: CREATOR,
        log_events: [mint(B, CURVE)],
      },
      {
        block_signed_at: "2026-11-13T11:50:00Z",
        from_address: CREATOR,
        // a mint and then an ordinary transfer of the same token
        log_events: [
          mint(A, CURVE),
          {
            ...mint(A, CREATOR),
            decoded: {
              ...mint(A, CREATOR).decoded,
              params: [
                { name: "from", value: CURVE },
                { name: "to", value: CREATOR },
                { name: "value", value: "5" },
              ],
            },
          },
        ],
      },
      { block_signed_at: "2026-11-13T11:40:00Z", from_address: CREATOR, log_events: [] },
    ];
    expect(launchesFrom(txs)).toEqual([
      { token: A, creator: CREATOR, at: Date.parse("2026-11-13T11:50:00Z") },
      { token: B, creator: CREATOR, at: Date.parse("2026-11-13T11:58:00Z") },
    ]);
  });
});

const report = (over: Partial<TokenScanReport> = {}): TokenScanReport =>
  ({
    address: A,
    token: { name: "Kitty", symbol: "KITTY", decimals: 18, totalSupply: "1000000000" },
    verdict: "risky",
    checks: [
      { id: "sell", label: "Can you sell it?", status: "ok", detail: "" },
      { id: "bundle", label: "Was the launch bundled or sniped?", status: "risk", detail: "" },
      { id: "deployer", label: "What else did the creator launch?", status: "warn", detail: "" },
    ],
    sellTest: { status: "passed" },
    liquidity: { curve: { progressPercent: 12.5 } },
    origin: { creator: CREATOR },
    ...over,
  }) as unknown as TokenScanReport;

describe("radarEntry", () => {
  it("keeps what the radar list shows", () => {
    const e = radarEntry(report(), "0xdead", NOW - 180_000, NOW);
    expect(e).toEqual({
      address: A,
      name: "Kitty",
      symbol: "KITTY",
      creator: CREATOR,
      launchedAt: new Date(NOW - 180_000).toISOString(),
      scannedAt: new Date(NOW).toISOString(),
      verdict: "risky",
      sell: "passed",
      bundle: "risk",
      deployer: "warn",
      progress: 12.5,
      risks: ["Was the launch bundled or sniped?"],
    });
  });
});

describe("radar page", () => {
  it("lists launches with escaped names and links to the token and the creator", () => {
    const e: RadarEntry = {
      ...radarEntry(report(), CREATOR, NOW - 240_000, NOW),
      name: `<img src=x onerror=alert(1)>`,
    };
    const html = radarMain([e], 2, NOW);
    expect(html).toContain(`href="/token/${A}"`);
    expect(html).toContain(`href="/creator/${CREATOR}"`);
    expect(html).toContain("4 min ago");
    expect(html).toContain("2 new launches waiting");
    expect(html).not.toContain("<img src=x");
  });

  it("says so when nothing has been scanned yet", () => {
    expect(radarMain([], 0, NOW)).toContain("Nothing scanned yet");
  });
});

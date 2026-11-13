import { describe, expect, it } from "vitest";
import type { TokenScanReport } from "../src/shared/api.js";
import {
  changes,
  firstEvents,
  snapshotOf,
  step,
  type TokenSnapshot,
} from "../src/worker/timeline.js";

const AT = "2026-11-13T12:00:00.000Z";
const snap = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  verdict: "clean",
  ownerStatus: "renounced",
  owner: "0x000000000000000000000000000000000000dead",
  supply: "1000000000",
  graduated: false,
  eth: 2,
  sell: "passed",
  ...over,
});

describe("changes", () => {
  it("records nothing when nothing changed", () => {
    expect(changes(snap(), snap(), AT)).toEqual([]);
  });

  it("describes mints, owners, liquidity drops and a failing sell", () => {
    const ev = changes(
      snap(),
      snap({
        supply: "2000000000",
        ownerStatus: "active",
        owner: "0x1234567890abcdef1234567890abcdef12345678",
        eth: 0.5,
        sell: "failed",
      }),
      AT,
    );
    expect(ev.map((e) => [e.kind, e.level])).toEqual([
      ["owner", "warn"],
      ["supply", "risk"],
      ["liquidity", "risk"],
      ["sell", "risk"],
    ]);
    expect(ev[2]!.text).toBe("ETH liquidity fell 75%, from 2 to 0.5 ETH.");
  });

  it("calls graduation graduation, not a liquidity drop", () => {
    const ev = changes(snap(), snap({ graduated: true, eth: null }), AT);
    expect(ev.map((e) => e.kind)).toEqual(["graduated"]);
  });
});

describe("step", () => {
  it("waits for a verdict change to show up twice", () => {
    const first = step(null, snap(), AT);
    expect(first.events).toEqual([]);
    const once = step(first.stored, snap({ verdict: "risky" }), AT);
    expect(once.events).toEqual([]);
    expect(once.stored).toMatchObject({ verdict: "clean", pending: "risky" });
    const twice = step(once.stored, snap({ verdict: "risky" }), AT);
    expect(twice.events).toEqual([
      {
        at: AT,
        kind: "verdict",
        text: "Mofu's verdict changed from clean to risky.",
        level: "risk",
        tx: null,
      },
    ]);
    // a flicker back and forth writes nothing
    const flick = step(twice.stored, snap({ verdict: "caution" }), AT);
    const back = step(flick.stored, snap({ verdict: "risky" }), AT);
    expect([...flick.events, ...back.events]).toEqual([]);
  });
});

describe("first events", () => {
  it("starts with the launch from the creation transaction", () => {
    const r = {
      verdict: "caution",
      origin: {
        creator: "0x636dd2c0299601df246efbfefcd67f12c9e57d08",
        launcher: "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
        createdAt: "2026-11-11T16:35:09Z",
        creationTx: "0xe916",
      },
      owner: { status: "none", address: null },
      token: { totalSupply: "1" },
    } as unknown as TokenScanReport;
    expect(firstEvents(r, AT)).toEqual([
      {
        at: "2026-11-11T16:35:09Z",
        kind: "launched",
        text: "Launched by 0x636d…7d08 on the Pons launchpad.",
        level: "info",
        tx: "0xe916",
      },
      {
        at: AT,
        kind: "first-scan",
        text: "First scanned by Mofu: caution.",
        level: "warn",
        tx: null,
      },
    ]);
    expect(snapshotOf(r)).toMatchObject({ verdict: "caution", graduated: false, sell: null });
  });
});

/**
 * For AI agents: a `buy_token` tool whose own code runs Mofu's check first. The model can call it
 * however it likes; a token Mofu flags is refused before any wallet code runs.
 *
 * The shape (name, description, JSON Schema, run) maps onto any tool-calling API: Claude's
 * tool use, OpenAI-style function calling, the Vercel AI SDK's tool(), MCP, and so on.
 */
import { buy } from "./agent.ts";
import { checkBeforeBuy } from "./mofu.ts";

export const tools = [
  {
    name: "check_token",
    description:
      "Ask Mofu what a Robinhood Chain token's contract allows (mint, pause, blacklist, fees, upgrades), whether a simulated sell works, and whether it copies another token's name. Returns allowed=false with reasons when the buy rule would refuse it.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
      required: ["address"],
      additionalProperties: false,
    },
    run: async ({ address }: { address: string }) => {
      const d = await checkBeforeBuy(address);
      return { allowed: d.allowed, reasons: d.reasons, verdict: d.report?.verdict ?? null };
    },
  },
  {
    name: "buy_token",
    description:
      "Buy a Robinhood Chain token with ETH. Mofu checks it first; the buy is refused, with reasons, if the check fails.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        amountEth: { type: "string", description: "ETH to spend, e.g. 0.001" },
      },
      required: ["address", "amountEth"],
      additionalProperties: false,
    },
    run: async ({ address, amountEth }: { address: string; amountEth: string }) => ({
      bought: await buy(address, amountEth),
    }),
  },
] as const;

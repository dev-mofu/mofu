# Safe trading agent template

A starting point for a trading agent on Robinhood Chain that asks [Mofu](https://mofu.works) before every buy and refuses tokens Mofu flags. Bring your own strategy and your own wallet code.

- No dependencies. Node.js 22.18 or newer runs the TypeScript files directly.
- Dry run by default: nothing is signed and nothing is sent until you write `executeBuy`.
- Uses Mofu's free public API, which allows 50 calls a day per IP (shared with Mofu's MCP server and `mofu-cli`). Reports are cached for 10 minutes.

This is a template, not a trading bot and not financial advice. Mofu checks what a token's contract allows and whether a simulated sell works. It can't see the future, and a clean report doesn't make a token a good buy.

## Run it

```sh
node agent.ts 0xf76593c1c321c2a2f77775025e9677999ce7ea8c
```

```
Checking 0xf76593c1c321c2a2f77775025e9677999ce7ea8c…
  ok $MOFU: verdict clean, sell test passed
  [dry run] would buy 0.001 ETH of 0xf76593c1c321c2a2f77775025e9677999ce7ea8c
```

A token that fails the rule is skipped, with reasons:

```
  skip $TRAP:
    - Mofu's verdict is risky
    - a simulated sell failed (possible honeypot)
```

## The files

| File                  | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `mofu.ts`             | Calls `GET /api/v1/token/{address}` and applies the buy rule (`decide`). Change the rule here. |
| `agent.ts`            | The loop: `findCandidates` (your strategy) → `buy` (the check) → `executeBuy` (your wallet).   |
| `tools.ts`            | `check_token` and `buy_token` as tool definitions for an AI model.                             |
| `webhook-receiver.ts` | Receives Mofu webhooks, checks the signature and pauses tokens that changed.                   |
| `paused.ts`           | The shared list of paused tokens (`paused.json`).                                              |

## The rule

`DEFAULT_POLICY` in `mofu.ts` refuses a token when:

- Mofu's verdict is `risky`, or any single check is a risk (for example, the owner can mint or block wallets);
- a simulated sell fails, or Mofu couldn't simulate one at all (`requireSellTest`);
- the buy or sell tax is over 10%;
- optionally, another token uses the same name or ticker (`blockLookalikes`).

If Mofu can't be reached, the answer is no. An agent that buys while its safety check is down isn't checking anything.

## Why the check sits inside `buy()`

If the check were a separate step, a strategy (or an AI model choosing tools) could skip it. In this template the only way to reach `executeBuy` is through `buy()`, and `buy()` asks Mofu first. `tools.ts` keeps that shape: the model's `buy_token` tool runs the same `buy()`.

## Webhooks: stop buying when something changes

Mofu can watch tokens and POST to your server when one changes: the owner moves, the supply changes, the code is upgraded, transfers are paused, liquidity drops 30% or more, or the verdict flips.

1. Run the receiver somewhere with a public https URL (your server, or a tunnel in front of your machine):

   ```sh
   node webhook-receiver.ts
   ```

2. Create the webhook. Mofu pings the URL first and only saves it if the ping gets a 2xx answer:

   ```sh
   npx mofu-cli webhook add https://your.domain/mofu 0xTOKEN
   ```

3. Restart the receiver with the secret it printed:

   ```sh
   MOFU_WEBHOOK_SECRET=whsec_… node webhook-receiver.ts
   ```

Events with a bad or old signature are rejected. Worrying events add the token to `paused.json`, and `buy()` skips paused tokens.

Full API and webhook reference: <https://mofu.works/docs/#api>

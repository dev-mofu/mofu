# mofu-sdk

Robinhood Chain token and wallet checks for agents, bots and scripts, from [Mofu](https://mofu.works).

- **Token Scanner:** what a contract allows (mint, pause, blacklist, fees, upgrades, owner), a simulated buy and sell with taxes, how big one sale can be before the price drops 10%, copycats, and whether the code matches known honeypots.
- **Wallet Health:** every active approval, re-checked on chain, with risky spenders flagged.
- **Webhooks:** a signed POST when a watched token's owner, supply, code, pause state, liquidity or verdict changes.
- **A buy rule** you can tune, so an agent refuses what Mofu flags.

No dependencies. Works wherever `fetch` and WebCrypto exist: Node.js 18+, browsers, Cloudflare Workers, Deno, Bun. The API is free: 50 calls a day per IP, shared with Mofu's MCP server and `mofu-cli`.

```sh
npm install mofu-sdk
```

## Check a token

```ts
import { Mofu } from "mofu-sdk";

const mofu = new Mofu();
const { report, url } = await mofu.scanToken("0xf76593c1c321c2a2f77775025e9677999ce7ea8c");

report.verdict; // "clean" | "caution" | "risky"
report.sellTest?.status; // "passed" | "failed"
report.sellTest?.depth?.ethAt10Percent; // ETH one sale can take before the price drops 10%
report.codeMatch; // same code as tokens whose sell failed, if any
report.deployer?.honeypots; // other tokens by the same creator whose sell failed
report.launch?.groups; // linked wallets that bought the launch, and what they still hold
url; // the shareable report on mofu.works
```

## Gate a buy

`checkBeforeBuy` scans and applies a rule. If Mofu can't be reached, the answer is no.

```ts
const d = await mofu.checkBeforeBuy(token, { maxSellTaxPercent: 5, minSellDepthEth: 0.5 });
if (!d.allowed) return console.log("skip:", d.reasons);
await yourBuy(token);
```

| Option              | Default      | Blocks when                                                    |
| ------------------- | ------------ | -------------------------------------------------------------- |
| `blockVerdicts`     | `["risky"]`  | the verdict is in the list (any single risk check also blocks) |
| `requireSellTest`   | `true`       | no sell could be simulated                                     |
| `maxBuyTaxPercent`  | `10`         | the simulated buy tax is higher                                |
| `maxSellTaxPercent` | `10`         | the simulated sell tax is higher                               |
| `blockLookalikes`   | `false`      | another token uses the same name or ticker                     |
| `minSellDepthEth`   | `null` (off) | a sale this size would move the price more than 10%            |

`decide(report, policy)` is the same rule as a pure function, for reports you already have.

## Check a wallet

```ts
const { report } = await mofu.checkWallet("0x…");
report.approvals.filter((a) => a.risk === "risk");
```

## Webhooks

```ts
const { webhook, secret } = await mofu.webhooks.create({
  url: "https://your.domain/mofu",
  tokens: ["0x…"],
  events: ["owner_changed", "liquidity_dropped", "verdict_changed"], // leave out for all six
});
// Mofu pinged your URL first; keep `secret`, it isn't shown again.

await mofu.webhooks.get(webhook.id, secret); // status, and when each token was last read
await mofu.webhooks.test(webhook.id, secret);
await mofu.webhooks.remove(webhook.id, secret);
```

In your handler, verify the signature against the raw body:

```ts
import { parseWebhook } from "mofu-sdk";

const event = await parseWebhook(request.headers.get("Mofu-Signature"), rawBody, secret);
if (event.type === "owner_changed") pause(event.token!.address);
```

`parseWebhook` throws when the signature is wrong or older than five minutes; `verifyWebhook` returns a boolean instead.

## Read a verdict on-chain

Mofu publishes verdicts to its MofuVerdicts registry on Robinhood Chain. Read one straight from the chain, without Mofu's API limits:

```ts
const v = await mofu.onchainVerdict(token); // finds the registry once via mofu.works
v.verdict; // "clean" | "caution" | "risky" | null (not published)
v.flags.sellFailed; // also honeypotCode, canMint, canPause, canBlock, upgradeable, fakeMofu
v.scannedAt; // Date | null
```

Pass `{ registry, rpcUrl }` to skip the lookup or use your own node.

## Errors

Failures throw `MofuError` with `status` and `code`: `daily_limit` (429), `bad_address` (400), `chain_unreachable` (503), `network` (Mofu couldn't be reached).

## Not advice

Mofu reads what a contract's code allows and simulates trades; it can't see the future. A clean report doesn't make a token a good buy.

Docs: <https://mofu.works/docs/#api> · Source: <https://github.com/dev-mofu/mofu/tree/main/packages/sdk> · MIT

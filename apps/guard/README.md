# Mofu Guard

A browser extension that checks what your wallet is about to sign, before you sign it.

- **Stops risky signatures.** Token approvals, approve-for-all on NFT collections, EIP-2612 and
  Permit2 permits, marketplace orders and blind `eth_sign` requests are shown in plain English
  first. You choose: don't sign, or continue to your wallet.
- **Flags drainer moves.** Unlimited approvals, spenders that are plain wallets, orders that ask
  nothing in return.
- **Checks Robinhood Chain contracts** with Mofu's Token Scanner (mint, pause, blacklist, fees,
  upgrades, owner).
- **Previews the result** of a transaction on Robinhood Chain, Ethereum, Base or Arbitrum before the wallet opens: what leaves
  the wallet and what comes back, simulated on mofu.works. It stops when the transaction would
  fail, when you'd give something and get nothing back, or when it sets an approval the request
  doesn't show.
- **Hover to scan** any contract address on a page, or right-click a selection → Scan with Mofu.

It never holds keys, never signs and never sends transactions. Sent to `mofu.works`: addresses
being checked on Robinhood Chain, and for the preview the transaction itself
(nothing is stored).

## Build

```sh
pnpm --filter @mofu/guard build
```

This writes the unpacked extension to `apps/guard/dist/` and a zip to
`apps/web/public/mofu-guard.zip` (served at `mofu.works/mofu-guard.zip`).

Load it in Chrome: `chrome://extensions` → Developer mode → Load unpacked → `apps/guard/dist`.

## How it works

- `src/inpage.ts` runs in the page and wraps the wallet provider's `request()` (window.ethereum,
  late-injected wallets, `ethereum.providers` and EIP-6963 announcements). Watched methods wait
  for the panel; everything else goes straight through.
- `src/content.ts` shows the panel and the hover tooltip inside a closed shadow root.
- `src/background.ts` decodes the request (`src/decode.ts`) and, on Robinhood Chain, adds checks
  from `GET https://mofu.works/api/guard/check?address=0x…` and a simulation from
  `POST https://mofu.works/api/guard/preview` (`src/preview.ts` reads it).

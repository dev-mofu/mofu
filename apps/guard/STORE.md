# Chrome Web Store listing (copy for the submission form)

**Name:** Mofu Guard

**Summary (132 characters max):**
Checks what your wallet is about to sign. Warns about unlimited approvals, permits and likely drainers.

**Category:** Productivity (or Tools)

**Description:**
Mofu Guard checks what you're about to sign, before you sign it.

When a website asks your wallet to approve tokens, approve a whole NFT collection, sign a permit or
sign a blind message, Mofu Guard shows what the request really does, in plain English, and lets you
stop it before your wallet even opens.

On Robinhood Chain, Ethereum, Base and Arbitrum it previews the result first: Mofu simulates the transaction and shows what
leaves your wallet and what comes back. It stops you when the transaction would fail, when you'd
give something and get nothing back, or when it quietly sets an approval the request doesn't show.

It flags the moves wallet drainers use most:

- Unlimited token approvals
- Approvals and permits that hand spending rights to a plain wallet instead of an app
- Marketplace orders that ask for nothing in return
- Blind eth_sign requests

On Robinhood Chain it also checks the token contract with Mofu's Token Scanner: can it mint new
tokens, pause transfers, block wallets, change fees or swap its code?

Hover any contract address on a page to see its scan, or select one and right-click → Scan with Mofu.

Mofu Guard never holds your keys, never signs anything and never sends transactions. It only reads
and warns. Source code: https://github.com/dev-mofu/mofu/tree/main/apps/guard

**Single purpose:** Help users understand wallet signing requests and contract addresses before
they act on them.

**Permission justifications:**

- Content scripts on http/https pages: needed to see wallet signing requests made by websites (the
  extension wraps the page's wallet provider) and to show the warning panel and hover scans.
- storage: saves the switches (protection, transaction preview, hover scan, labels on X) and, locally only, the
  addresses the user has sent to, to catch lookalike (poisoned) addresses.
- contextMenus: adds "Scan with Mofu" for selected addresses and transaction hashes.
- Host permission https://mofu.works/*: asks Mofu's API to check a contract or spender address on
  Robinhood Chain, and to simulate a transaction for the preview (Robinhood Chain, Ethereum, Base, Arbitrum).

**Data use:** Does not collect personal data, browsing history, wallet keys or balances. The only
data sent off the device is the contract or spender address being checked (including contract
addresses shown in X posts, for the labels), and for the preview the transaction
itself (sender, contract, ETH amount, call data), to mofu.works, which simulates it and stores
nothing. Privacy
policy: https://mofu.works/guard/ (section "What it sends, and to whom") and
https://mofu.works/privacy/

**Screenshots (1280×800):** take them from the test dapp flow (approval panel, permit panel, hover
tooltip, popup). **Small promo tile (440×280)** and **icon (128×128):** static/icons/icon-128.png.

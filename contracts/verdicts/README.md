# MofuVerdicts

Mofu's Token Scanner verdicts on Robinhood Chain (chain ID 4663), readable by any contract, wallet or bot with one call:

```sh
cast call <registry> "verdictOf(address)(uint8,uint8,uint40,bytes16)" <token> \
  --rpc-url https://robinhood-rpc.publicnode.com
```

| Field         | Meaning                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`     | 0 not scanned, 1 clean, 2 caution, 3 risky                                                                                                        |
| `flags`       | bits: 1 sell test failed, 2 code matches known honeypots, 4 can mint, 8 can pause, 16 can block wallets, 32 upgradeable, 64 copies the $MOFU name |
| `scannedAt`   | Unix time of the scan, in seconds                                                                                                                 |
| `fingerprint` | Mofu's code fingerprint of the token (16 bytes)                                                                                                   |

Only the `writer` address can publish; the `owner` can point publishing at a new writer key. A verdict describes what a token's code allows and a simulated sell. It isn't advice.

## Tests

```sh
forge test
```

## Setting it up (owner's checklist)

The registry and the writer key are run by Mofu's owner. Nothing here needs a key in a file.

1. **Make a writer wallet** used for nothing else, and keep its private key safe:

   ```sh
   cast wallet new
   ```

   Send it a little ETH on Robinhood Chain for gas. Each publish is one transaction carrying up to 25 verdicts.

2. **Deploy the registry** from your own wallet (it becomes the owner), with the writer's address:

   ```sh
   cast wallet import mofu-owner --interactive
   forge create src/MofuVerdicts.sol:MofuVerdicts --rpc-url robinhood \
     --account mofu-owner --broadcast --constructor-args <writer address>
   ```

3. **Give the Worker the writer key** as a Cloudflare secret (it's asked for interactively, never stored in the repo):

   ```sh
   cd apps/web
   npx wrangler secret put VERDICT_SIGNER_KEY
   ```

4. **Turn publishing on**: set `VERDICTS_CONTRACT` in `apps/web/wrangler.jsonc` to the registry address and deploy. `VERDICT_DAILY_TXS` caps transactions a day (default 48).

5. **Check it**: `https://mofu.works/api/v1/onchain` shows the registry, the writer, what's pending and the last transaction.

To rotate the writer key: make a new wallet, call `setWriter(<new address>)` from the owner, and replace the secret.

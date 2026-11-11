# Launching Mofu

Step-by-step checklist for the owner. Do the steps in order; each one says how to check it worked. Commands run in a terminal at the repository root unless a step says otherwise. Read [AUDIT.md](AUDIT.md) first.

You need: this repository, Node.js 22.13+, pnpm, your Cloudflare account (already logged in to Wrangler on this computer), an OpenRouter account with credit and an npm account.

---

## 1. OpenRouter: a separate production key with a limit

The key in `apps/web/.dev.vars` is for development. The live site gets its own key, so you can cap and rotate it on its own.

1. Go to <https://openrouter.ai/settings/keys> → **Create key**.
2. Name: `mofu-production`. **Credit limit: $3** (or $0.50 with a daily reset, if offered).
3. Copy the key (starts with `sk-or-v1-`). You'll paste it in step 3. Don't put it in any file.
4. Optional: rename your current key to `mofu-development` and give it a limit too.

Check: the new key shows in the list with its limit.

## 2. Cloudflare: Turnstile for the real domain

The repo uses Cloudflare's test keys, which let every request through. Production needs real ones.

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Name `Mofu`. Hostnames: your domain (step 6) **and** `mofu-web.<your-subdomain>.workers.dev` (shown after the first deploy; you can add it later). Widget mode: **Managed**.
3. You get a **site key** (public) and a **secret key**.
4. Put the site key in `apps/web/wrangler.jsonc`:

   ```jsonc
   "TURNSTILE_SITE_KEY": "0x4AAAAAAA…your site key…",
   ```

   Local development keeps working: `apps/web/.dev.vars` sets the test key for your machine.

Check: `pnpm --filter @mofu/web build && node apps/web/scripts/check-deploy.mjs` prints `Deploy checks passed.` (with the test key it refuses).

## 3. Secrets

Run these from `apps/web`. Each asks you to paste the value; nothing is saved in the repo.

```sh
cd apps/web
npx wrangler whoami                        # should show your account (your Cloudflare account)
npx wrangler secret put OPENROUTER_API_KEY # the production key from step 1
npx wrangler secret put TURNSTILE_SECRET_KEY # the Turnstile secret from step 2
npx wrangler secret put SESSION_SECRET     # 32+ random characters, see below
```

| Secret                 | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`   | Pays for free-tier messages.                                        |
| `TURNSTILE_SECRET_KEY` | Verifies the bot check.                                             |
| `SESSION_SECRET`       | Signs the session cookie. Changing it logs everyone out (harmless). |

Make a random session secret with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

If `wrangler secret put` says the Worker doesn't exist yet, do step 5 first (the site will show errors until the secrets are in), then come back.

Settings that aren't secret live in `wrangler.jsonc` → `vars`: `DEFAULT_MODEL`, `FREE_DAILY_LIMIT` (10), `FREE_TIER_ENABLED` (`"true"`), `TURNSTILE_SITE_KEY`.

## 4. Nothing else to create

The rate limiter is a Durable Object; `wrangler deploy` creates it from the `migrations` in `wrangler.jsonc`. No KV namespace or other resources are needed.

## 5. Deploy the web app

```sh
cd apps/web
pnpm run deploy    # build → safety checks → wrangler deploy (not `pnpm deploy`, a different pnpm command)
```

Wrangler prints the URL, like `https://mofu-web.<your-subdomain>.workers.dev`.

Smoke test (about 5 minutes, 4–5 free messages):

1. `/` shows the landing page; **Try it free** opens `/app/`; `/docs/` loads.
2. In the app, send a message in **General**. The bot check appears once, then the answer streams.
3. Try one message each in **Data Analyst** (any small CSV), **Study Buddy** (any PDF → Summary) and **Dev Tools** (a public GitHub repo).
4. The usage label counts down ("… free messages left today").
5. **Settings** → paste your development key → send a message: the label changes to "Your key".

## 6. Your domain (optional, recommended)

Candidates: `getmofu.com`, `usemofu.com`, `trymofu.com` (check availability when you buy).

1. Buy it through Cloudflare Registrar (dashboard → **Domain Registration**), or add an existing domain to Cloudflare.
2. Dashboard → **Workers & Pages** → `mofu-web` → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `getmofu.com` (and `www.getmofu.com` if you like).
3. Add the domain to the Turnstile widget's hostnames (step 2).
4. Tell Claude the domain: the `og:image` link previews need the full URL (`https://getmofu.com/og.png`) in `apps/web/index.html` and `apps/web/docs/index.html`; then deploy again.

Check: the domain shows the landing page over HTTPS; sharing the link in a chat shows the Mofu preview image.

## 7. Publish the CLI to npm

1. `npm login` (or create an account at <https://www.npmjs.com/signup>).
2. Turn on two-factor auth: `npm profile enable-2fa auth-and-writes`.
3. Check the name is still free: `npm view mofu-cli` should say **404 Not Found**. If it's taken, tell Claude; the package needs a new name (e.g. `mofu-agent` or `@yourname/mofu`). (npm refused plain `mofu` as too similar to `mobx` and `defu`, which is why the package is `mofu-cli`.)
4. Publish:

   ```sh
   cd apps/cli
   pnpm publish --access public    # builds first (prepack); asks for your 2FA code
   ```

Check, in a new empty folder:

```sh
npx mofu-cli@latest --version          # 0.1.0
npx mofu-cli@latest auth               # paste a key
npx mofu-cli@latest "say hi"
```

## 8. First week

- **OpenRouter** → Activity: spend per day. Expect around $0.001 per message.
- **Cloudflare** → Workers & Pages → `mofu-web` → Metrics: requests, errors, CPU time. If you see "exceeded CPU" errors, switch to the Workers Paid plan ($5/month).
- If a day costs more than about $0.50, lower `FREE_DAILY_LIMIT` in `wrangler.jsonc` (e.g. to 5) and deploy again (`pnpm run deploy` in `apps/web`).

---

## Recovery playbook

**Stop all free-tier spending now (kill switch)**

- Fastest: dashboard → Workers & Pages → `mofu-web` → **Settings** → **Variables** → set `FREE_TIER_ENABLED` to `false` → **Deploy**. Takes effect in seconds; BYOK users keep working.
- Or in the repo: set `"FREE_TIER_ENABLED": "false"` in `apps/web/wrangler.jsonc`, then `pnpm run deploy`.
- Undo: set it back to `"true"`.
- Note: the next `pnpm run deploy` applies the values in `wrangler.jsonc` again, so after a dashboard change, update `wrangler.jsonc` to match.

**The OpenRouter key leaked or is being abused**

1. OpenRouter → Keys → create a new production key (with a limit).
2. `cd apps/web && npx wrangler secret put OPENROUTER_API_KEY` → paste the new key.
3. Delete the old key in OpenRouter. Done; no deploy needed.

**A deploy broke the site**

```sh
cd apps/web
npx wrangler deployments list      # find the last good version
npx wrangler rollback <version-id> # or just: npx wrangler rollback (previous version)
```

**A bad CLI release**

```sh
npm deprecate mofu-cli@0.1.1 "Broken release, use 0.1.0"
```

then publish a fixed version. (`npm unpublish` only works within 72 hours and blocks the version number forever; prefer deprecate.)

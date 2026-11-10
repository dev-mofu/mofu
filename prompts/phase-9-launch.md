# Phase 9 — Launch readiness

Read `prompts/00-project-brief.md` first. Phases 1–8 must be complete.

## Goal

Get Mofu ready to go public safely and cheaply. Then deploy the web app and publish the CLI, but only with the owner's explicit go-ahead at each outward-facing step. Deploying and publishing are outward actions. Prepare everything, show the owner the exact commands, and wait.

## Scope

### 1. Pre-launch audit (do first, report before anything goes live)

**Security**
- Re-run the phase 2 security checklist.
- Confirm:
  - no secrets in the repo or git history
  - BYOK keys never logged
  - SSRF guards on every server-side fetch
  - the Worker proxy only allows the allowlisted hosts
  - CLI approvals cover every write/exec tool

**Cost**
- Measure average tokens per message for each mode with the default model. Estimate cost per message and how many free messages $6 covers.
- Recommend a daily limit and per-key credit cap from that.

**Limits**
- Check every cap (body size, history, steps, output tokens, file sizes, PDF pages, Python timeout) is enforced server-side or in the sandbox, not only in the UI.

**Licensing and terms**
- List each external API's terms that apply. Note in particular:
  - Open-Meteo free tier is non-commercial
  - Wikipedia content needs attribution
  - Crossref etiquette
  - GitHub unauthenticated limits
- Check the footer attributions.
- Check the licenses of npm dependencies for anything incompatible with publishing.

**Privacy**
- Draft a short, honest privacy policy and terms page from the actual behavior, for the owner to review. Mark it clearly as a draft that is not legal advice.
- Cover:
  - what is sent to OpenRouter and the model provider
  - what is stored and where (localStorage, `~/.mofu`)
  - logs
  - IP use for rate limiting

### 2. Owner checklist (prepare; the owner does these)

Write `LAUNCH.md` with step-by-step instructions the owner follows:

- Create two OpenRouter API keys (development and production) and set a credit limit on the production key.
- Create the Cloudflare account resources:
  - Worker
  - Turnstile site (production keys)
  - KV/Durable Object/rate-limit binding from phase 2
  - domain (candidates: `getmofu.com`, `usemofu.com`, `trymofu.com`; check availability at purchase)
- Set Wrangler secrets (list each one and its purpose).
- npm: log in, check that the `mofu` name is still free, enable 2FA.
- Recovery playbook:
  - flip the free-tier kill switch
  - rotate the OpenRouter key
  - roll back a deploy

### 3. Release preparation

**CLI package**
- Correct `bin`, `files`, `engines` (Node 20+), README with install/usage, license.
- `npm pack` dry run.
- Test the packed tarball with `npx ./mofu-x.y.z.tgz` on Windows.

**Web**
- Production build.
- `wrangler deploy --dry-run`.
- Environment separation (dev/prod).
- Custom domain routing notes.

**Versioning**
- Set version `0.1.0`.
- Write a CHANGELOG.

**Root README**
- What Mofu is.
- Screenshots.
- Web and CLI quick start.
- Self-hosting notes.
- Data source attributions.

### 4. Go-live (only after the owner says go, one step at a time)

1. `wrangler deploy` to production. Smoke test the live site:
   - Turnstile
   - one free message per mode
   - limit reached
   - BYOK
   - landing page
2. `npm publish` (the owner runs it, or approves you running it in their authenticated shell). Smoke test `npx mofu@latest` on a clean machine or directory.

### 5. After launch

- Watch Cloudflare analytics and OpenRouter usage for the first day.
- Report spend so far, messages served and errors.
- Suggest limit adjustments.

## Out of scope

Marketing, paid plans, accounts, new features. Note feature ideas in a `ROADMAP.md` instead of building them.

## Verification

- The audit report is complete, with every item marked pass/fail and fixes made for failures.
- `LAUNCH.md` is complete enough that the owner can follow it without asking questions.
- Packed CLI tested on Windows.
- Deploy dry run passes.
- Live smoke tests pass (after go-ahead).

## Report

Follow "How to work on a phase" in the brief, plus:
- the cost-per-message table and recommended limits
- the audit results
- exactly which outward actions were taken and by whom

# Phase 2 — Web workspace on Cloudflare Workers

Read `prompts/00-project-brief.md` first. Phase 1 must be complete.

## Goal

Build the web app shell: a chat workspace that streams responses from the shared core agent, runs on Cloudflare Workers, and is safe to expose publicly for free. That means rate limits, bot protection, hard caps and bring-your-own-key. Later phases add each mode's features into this shell, so build it so a mode can plug in its own tools, input panel and result views.

## Scope

### 1. Project setup (`apps/web`)

- React + Vite frontend, built to static assets.
- Hono API in a Worker, configured with `wrangler.toml` to serve the static assets and the `/api/*` routes from one Worker.
- Local development with `wrangler dev` plus Vite. Document the commands.
- `.dev.vars.example` listing every secret and variable (`OPENROUTER_API_KEY`, `TURNSTILE_SECRET_KEY`, `SESSION_SECRET`, `DEFAULT_MODEL`, `FREE_DAILY_LIMIT`, …).

### 2. Chat API

`POST /api/chat`:
- Streams the agent's output using the AI SDK's streaming response format, so the frontend can use the matching AI SDK UI hooks.
- Uses the core agent runner with tools for the `web` surface only. No server-side `write`/`exec` tools, ever.
- Takes the selected mode, so the server picks that mode's system-prompt section and tool set (only "general" exists in this phase).

Enforce on every request:
- Maximum request body size.
- Maximum messages and characters of history (trim the oldest turns first).
- Maximum agent steps and output tokens.
- A server-side timeout.

### 3. Free tier protection

- **Turnstile**:
  - The widget runs on first use.
  - The server verifies the token, then issues a short-lived signed session cookie (HMAC with `SESSION_SECRET`).
  - Requests without a valid session are rejected.
  - Use Cloudflare's test keys in development.
- **Daily limit per IP**: 10 messages per day by default (`FREE_DAILY_LIMIT`).
  - Use a Cloudflare-native store: the Workers rate limiting binding, KV or a Durable Object. Pick one and justify it in your report. A per-day counter must be accurate enough that a burst can't blow past the limit.
  - Return a clear 429 response with when the limit resets. The UI shows a friendly message and offers BYOK.
- **Global kill switch**: an environment variable that disables the free tier (BYOK keeps working). Lets the owner stop spending instantly.

### 4. Bring your own key

- Settings panel where the user pastes an OpenRouter key.
  - Stored only in localStorage.
  - Sent in a request header.
  - The server uses it for that request only and never logs or stores it.
- BYOK requests skip the daily limit and may choose a model from a short curated list plus a free-text model ID.
- Validate the key with a cheap call when saved, and show whether it works.

### 5. Frontend

**Layout**
- Mode switcher: General, Data Analyst, Study Buddy, Dev Tools. Unbuilt modes show "Coming soon".
- Chat thread.
- Composer with a file drop zone. The drop zone only accepts and lists files in this phase; later phases process them.
- Settings (BYOK, model, theme).
- Memory panel.

**Messages**
- Streaming text with Markdown and syntax-highlighted code blocks.
- Tool calls shown as compact, expandable rows.
- Stop button.
- Retry on error.
- Free-tier usage counter ("7 of 10 messages left today").

**Memory**
- Stored in localStorage and sent with each request as context. The server never stores it.
- Users can view, edit and delete entries.
- The `save_memory` tool works on the web by returning the fact to the client, which saves it.

**Design**
- Follow the brand section of the brief: dark warm background, dot grid, pink accent, pill buttons, LED badge for the agent status (READY / THINKING / done).
- Light mode toggle.
- Use the Mofu sprite from `mascot/mofu-mascot.html` small in the header or empty state.
- Responsive down to 360px wide.
- Visible keyboard focus.
- Respects `prefers-reduced-motion`.

### 6. Web-safe tools

Register `wikipedia_summary` and `define_word` for the web surface and show Wikipedia attribution (title + link) whenever its content is used.

## Out of scope

Mode features (later phases), the landing page (phase 8), deployment (phase 9). Do not deploy. You may prepare the deploy command.

## Security checklist

All must hold, and the report must confirm each one:

- [ ] No server route executes model- or user-provided code.
- [ ] API keys (owner's and BYOK) never appear in logs, error messages or responses.
- [ ] Request contents aren't logged.
- [ ] CORS only allows the app's own origin.
- [ ] Cookies are `HttpOnly`, `Secure`, `SameSite=Lax` or stricter.
- [ ] Every limit in this prompt is enforced server-side, not just in the UI.

## Cost discipline

- Use the cheap default model.
- No more than about 20 live model calls for the whole phase.
- Test the rate limiter and Turnstile flow with mocked model responses, not real ones.

## Verification

1. Build, lint, typecheck and tests pass.
2. Unit/integration tests (with a mocked model) cover:
   - session issuance and rejection
   - the daily limit hitting 429
   - the kill switch
   - BYOK bypassing the limit
   - request caps
   - that the web tool set contains no `write`/`exec` tools
3. Manual run in Chrome via `wrangler dev`:
   - send messages
   - watch streaming
   - stop a response
   - hit the limit (temporarily set it to 2)
   - add a BYOK key
   - save and delete a memory
   - switch light/dark
   - check a 360px-wide viewport

## Report

Follow "How to work on a phase" in the brief, plus the security checklist and the storage choice for the rate limiter.

> **DRAFT for the owner to review. Not legal advice.** Written from how the code behaves on 2026-11-11. Have someone qualified review it before publishing, and update it when the behavior changes.

# Privacy policy

Mofu is an AI agent you can use in your browser (the "web app") or in your terminal (the "CLI"). This page explains what data is involved and where it goes.

## The short version

- No account. We don't ask for your name or email.
- Files you open in the web app are read in your browser and aren't uploaded to Mofu's server.
- Your messages, and the parts of your files needed to answer, are sent to an AI model through OpenRouter.
- Mofu's server doesn't store your messages, files or API key. It keeps a daily message count per IP address for the free tier.

## What is sent where (web app)

**To Mofu's server (a Cloudflare Worker), then to OpenRouter and the model provider:**

- your messages and the conversation so far;
- facts you asked Mofu to remember;
- context Mofu needs to answer, built in your browser: for example a profile of your spreadsheet (column names, types, summary statistics), the results of Python run on it, an outline and the pages of a document it reads, a GitHub repository overview, the list of packages in a dependency scan, or an API spec's endpoint list;
- your own OpenRouter key, if you added one, so the request is billed to you.

OpenRouter passes the request to the model provider (by default Anthropic). Their own privacy policies and terms apply: <https://openrouter.ai/privacy>.

**Directly from your browser to other services:** depending on what you do, your browser contacts GitHub (to read a public repository), OSV and deps.dev (vulnerability and package data), public data APIs (exchange rates, holidays, weather, World Bank), Wikipedia and dictionary services, Crossref, Open Library, Datamuse, and jsDelivr (to download the Python runtime). They see your IP address and the request (for example a package name or a search term), as with any website.

**Bot check:** Cloudflare Turnstile runs before your first message. Cloudflare's privacy policy applies.

## What is stored, and where

| Where                       | What                                                                                                                                                                               | How long                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mofu's server               | A count of free messages per IP address per day                                                                                                                                    | Deleted about an hour after the daily reset (midnight UTC)                          |
| Mofu's server               | A signed session cookie (no personal data)                                                                                                                                         | 2 hours                                                                             |
| Mofu's server logs          | The type of an error when something fails (no message content, no keys)                                                                                                            | Cloudflare's standard log retention                                                 |
| Your browser (localStorage) | Settings (theme, model), your own key if you add one, what you asked Mofu to remember, flashcard progress                                                                          | Until you remove it (Settings → Remove key, Memory → Clear all, or clear site data) |
| Your computer (CLI)         | `~/.mofu/config.json` (your key, if saved with `mofu auth`), `~/.mofu/memory.md`, `~/.mofu/study/` (flashcard progress), `~/.mofu/pyodide-cache/`, and reports in `./mofu-output/` | Until you delete them                                                               |

Mofu's server doesn't store chats or files and doesn't use your data to train models. Whether a model provider keeps data is governed by OpenRouter's and the provider's policies.

## Your IP address

The free tier counts messages per IP address to keep the service affordable. The IP address is used as the key of that counter and is deleted with it.

## The CLI

The CLI runs on your computer. It sends your messages, and the file contents it reads to answer, to OpenRouter using your own key. When it fetches a web page or API spec you give it, or runs API tests, it contacts those addresses from your computer.

## Children

Mofu isn't directed at children under 13.

## Changes and contact

We'll update this page when Mofu's behavior changes. Contact: [owner to add a contact email or link].

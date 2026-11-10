# Phase 8 — Landing page

Read `prompts/00-project-brief.md` first. Phases 1–7 must be complete, so the page can show real features.

## Goal

Build Mofu's public landing page. In a few seconds it should show what Mofu does (drop a file, get real work back), feel distinctive and playful, and send visitors either to the web app or to `npx mofu`.

## Style reference

`referensi tampilan web nya.mp4` in the project root shows the style the owner likes. If you can't view video, use this description of the qualities to reproduce:

- Dark, warm near-black background with a faint dot grid and slowly twinkling pixel stars.
- Monochrome pixel-art / dot-matrix scenery: a moon with dotted rings, drifting pixel clouds, a mountain range along the bottom of the hero, a city skyline in the closing section.
- A centered hero: two-line headline in a thin geometric sans, a mascot peeking over the top edge of a demo card, and a white pill CTA with an arrow below.
- The demo card animates through an agent's states. Text types itself into the card, an LED dot-matrix badge in the corner changes (READY → SEARCHING → FOUND), the card shows a "working" visual, then lands on a result.
- A features section where a dotted vertical timeline runs down the left, with a small pixel icon that travels along it as you scroll. Each feature is a dark rounded card with text on the left and a pixel illustration on the right.
- Testimonials row, a closing CTA card with a pixel skyline, and a simple footer.
- Floating rounded navbar, language selector, theme toggle.

This reference belongs to an unrelated travel product. Reproduce the qualities, not the content. Do not reuse its name, mascot, illustrations, copy, icons or exact layout. Every asset here must be original.

## Page structure

1. **Navbar** (floating, rounded): Mofu logo (small sprite + wordmark), links (Features, CLI, Privacy, FAQ), theme toggle, "Open app" pill button.

2. **Hero**
   - Headline: two short lines in the spirit of "Drop a file. Mofu does the work." Write two or three alternatives in your report for the owner to choose from.
   - Demo card with the Mofu sprite peeking over its top edge (enlarge the paws compared to the concept file so they read clearly). It cycles through three scenarios, each with matching mascot expression and LED badge:

     | Scenario | Input | Badge | Working visual | Result |
     |---|---|---|---|---|
     | Data | `sales.csv` | ANALYZING | Dot-matrix bar chart drawing itself | "March revenue dropped 18%", with a highlighted bar |
     | Dev | `package.json` | SCANNING | Package rows ticking | "3 vulnerable packages, 1 critical" |
     | Study | `chapter-3.pdf` | STUDYING | Pages flipping | A flashcard flipping over |

   - CTAs: white pill "Try it free" → web app; next to it a copyable `npx mofu` code chip with a copy confirmation.
   - Pixel night scene behind: moon, clouds, stars, mountains.

3. **Features timeline**: four cards with original pixel illustrations:
   - Data Analyst (chart)
   - Study Buddy (book/flashcards)
   - Dev Tools (shield + terminal)
   - CLI (terminal window)

   A dotted line with a pixel cursor icon that moves as you scroll.

4. **How it works**: three steps (Drop a file → Mofu works with real tools → Get a usable result), each with a small mascot expression.

5. **Privacy**: plain, accurate claims only. For example: raw data stays in your browser where possible, code runs on your device, no account needed, your own key never leaves your browser except to call the model. Do not overclaim. Get every claim checked against the actual implementation.

6. **CLI section**: a terminal mock showing a short real-looking `mofu deps` or `mofu task` session.

7. **FAQ**:
   - Is it free?
   - What are the limits?
   - Which models?
   - Bring my own key?
   - What data do you store?
   - Which file types?

8. **Closing CTA** card with pixel skyline.

9. **Footer**:
   - links
   - data source attributions (Wikipedia, Open-Meteo, OSV, …)
   - "Not affiliated with" notes if needed
   - license

Testimonials: there are no real users yet. Leave the section out, or ship it behind a flag with obvious placeholders. Never publish fabricated quotes.

## Technical requirements

- Lives in `apps/web`, served at `/`. The app moves to `/app` (or similar); update routes and links.
- Pixel art drawn with canvas or SVG from sprite data (reuse the grid in `mascot/mofu-mascot.html`). No raster images for the pixel scenes, so they stay crisp at any scale.
- Animations:
  - Driven by `requestAnimationFrame` / CSS.
  - Pause when off-screen.
  - Fully static, readable version under `prefers-reduced-motion`.
- Performance: Lighthouse performance and accessibility at 90 or above on mobile. Fonts loaded efficiently, no layout shift from the hero animation.
- Responsive from 360px wide with a 16px side gutter and no horizontal scroll. The demo card stays legible on phones.
- Light mode version of every section.
- SEO basics: title, description, Open Graph image (render one from the mascot), favicon from the dot-matrix sprite.
- Accessible:
  - semantic headings
  - alt text / `aria-hidden` for decorative art
  - visible focus
  - sufficient contrast for the pink on dark

## Out of scope

Blog, docs site, internationalization (the language selector can be omitted or show English only), analytics beyond Cloudflare's built-in.

## Verification

1. Build, lint, typecheck and tests pass.
2. Screenshots at 1440px, 768px and 375px, dark and light, included in the report.
3. Lighthouse mobile scores reported.
4. Manual check in Chrome:
   - all three hero scenarios loop
   - copy button works
   - reduced-motion mode shows the static version
   - all links work
   - the app still works at its new route

## Report

Follow "How to work on a phase" in the brief, plus the headline alternatives, screenshots and Lighthouse scores.

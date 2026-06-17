# CLAUDE.md — REF/CHECK AI Landing Page

## What this is
A single-page marketing **landing page** for **REF/CHECK AI** — an AI-powered academic
manuscript/reference verification platform (checks whether each citation in a paper is
*real* and *actually supported* by its source, via CrossRef/PubMed + an AI claim check).
This repo is **only the landing page**, not the product itself.

## Stack
- **Static site**: plain `index.html` + `app.js`. No build step, no framework, no npm.
- **Tailwind via CDN** with an inline `tailwind.config` in a `<script>` in `index.html`
  (classes are generated at runtime in the browser).
- **Vanilla JS** (one IIFE in `app.js`). No bundler.
- **Fonts**: Space Grotesk (display), Inter (body), JetBrains Mono (labels), Material
  Symbols (icons) — all from Google Fonts CDN.
- Platform: Windows / PowerShell. **Not a git repo.**

## Run it
```bash
python -m http.server 8000      # from the project root
# open http://localhost:8000
```
Stop: `Stop-Process -Name python` (PowerShell). The user runs it locally; **nothing is
published/deployed** yet. Always verify a change with:
`(Invoke-WebRequest http://localhost:8000 -UseBasicParsing).StatusCode` → expect `200`.

## Files
- `index.html` — all markup + the design system: `tailwind.config` (color/font/size
  tokens) and a big `<style>` block with the custom CSS utilities below.
- `app.js` — all interactivity, structured as commented sections inside one IIFE.
- `CLAUDE.md` — this file.

## Design language
Monochrome, high-tech, **igloo.inc-inspired**: near-black canvas, white/silver accents,
glass surfaces, subtle grain + grid + aurora bloom. The ONLY hue allowed broadly is the
**rich-orange cursor glow** on cards. Semantic color (green/amber/red) appears *only* on
verification states and is intentionally muted.

### Color tokens (in `tailwind.config`)
- Surfaces: `bg #060607`, `bg-soft`, `surface #101012`, `surface-2`, `surface-3`
- Borders: `border-subtle rgba(255,255,255,.09)`, `border-strong`
- Text: `ink #F4F4F6`, `ink-soft #ADADB6`, `ink-mute #8A8A93`
- Accents (grayscale): `accent #FFFFFF`, `accent-2 #A6A6AE`, `accent-3 #D4D4DA`
- Semantic (muted): `ok #7FC8A0`, `warn #D9B776`, `bad #DB8793`

### Key custom CSS utilities (in `index.html <style>`)
- `.glass` — translucent dark surface + `backdrop-filter: blur` + inner top highlight.
- `.beam` — **cursor-tracking orange spotlight glow border** (see below). On most cards.
- `.btn-primary` — primary CTA: white pill at rest → indigo/purple/pink gradient fills
  the face **on hover** (text stays black). Needs `isolation: isolate` so the negative-z
  `::after` gradient paints over the white background.
- `.glass-liquid` — lighter frosted variant for secondary buttons.
- `.gradient-text` / `.shimmer-text` — silver gradient / animated silver shimmer.
- `.lift` — hover translateY + border/shadow (note: JS tilt overrides its transform).
- `.ptab` / `.panel-anim` — platform-preview sidebar tabs + panel enter animation.
- `.aurora`, `.bg-grid`, `.marquee-track`, `.scanline`, `#spotlight`, `#scroll-progress`.

## app.js modules (in order)
1. Sticky navbar styling on scroll.
2. Scroll-progress bar.
3. Mobile menu toggle.
4. Scroll reveal (`[data-reveal]` / `[data-stagger]`) via IntersectionObserver.
5. Count-up stats (`[data-count]` / `[data-suffix]`).
6. "Processing" progress bar in How-It-Works.
7. Active-nav scrollspy (`sections` array — keep in sync when adding sections).
8. Cursor spotlight (`#spotlight`) — ambient page glow, follows mouse.
9. **Hero mockup 3D tilt** (`#hero-mockup .tilt`) — separate from `.beam` tilt.
10. **Platform preview tabs** (`#platform-card`, `[data-tab]`/`[data-panel]`).
11. **Spotlight glow cards** — the `.beam` loop: per-card `pointermove` sets `--x/--y/--xp`
    (glow position) AND applies the **3D tilt** (±6°, perspective 1000px, translateY(-4px));
    `pointerleave` eases back to flat.
12. Hero particle-network canvas.

## Page sections (top → bottom)
Hero (asymmetric: copy left, live analysis-panel mockup right with 2 floating badges) →
trusted-by marquee → **Features bento** → How It Works (5-step) → **Platform preview**
(interactive tabbed mini-app) → Verification results table → Audience bento → Testimonials
→ CTA → footer. Nav links + scrollspy cover: features, how-it-works, platform,
verification, audience.

## The `.beam` spotlight glow (important — many gotchas)
Ported from a 21st.dev "spotlight-card" / GlowCard React component into vanilla CSS+JS.
- **Rich orange, hover-only.** Tunable vars on `.beam`: `--base:16 --spread:14`
  (hue range, keep in orange band), `--size:520` (glow radius — bigger = triggers from
  farther), `--border:2` (ring thickness). `::before` = orange ring, `::after` = warm core.
- Border ring is drawn with the `mask` + `mask-composite: exclude` padding trick.
- **DO NOT use `background-attachment: fixed`** (the original technique). Our cards use
  `backdrop-filter`, which makes them a containing block for fixed backgrounds → the glow
  freezes off-card. Instead JS tracks the pointer **locally per card** (`clientX-rect.left`).
- **DO NOT gate the JS behind `matchMedia("(pointer:fine)")`** — touch-capable Windows
  laptops report a coarse primary pointer even with a mouse, which froze the glow. The
  `.beam` pointer/tilt loop is intentionally ungated.
- The **hero/first card has no `.beam`** (and no tilt) by design — user wants it clean.
- `.beam` is on: feature tiles, How-It-Works processing card, verification table,
  audience cards, testimonials, platform card. NOT on the small mock cards *inside* the
  platform preview (they're a simulated screen).

## Conventions & gotchas
- **Tailwind `hidden` vs `flex`/`grid` conflict**: don't combine them on toggled elements.
  The platform panels toggle visibility via inline `style.display`, not the `hidden` class.
- **Buttons with gradient overlays** need `isolation: isolate` + a negative-z `::after`
  so the gradient sits over the solid background but under the label.
- **Material Symbols, never emoji**, for icons. One icon family throughout.
- **Accessibility**: white `:focus-visible` outlines exist — keep them. `prefers-reduced-
  motion` disables animations/tilt — preserve those guards. Keep body-text contrast ≥4.5:1
  (that's why `ink-mute` was lightened).
- When **adding a section with an id**, update both the nav links (desktop + mobile) and
  the `sections` array in app.js (scrollspy).
- When adding a card that should glow+tilt, just give it the `beam` class — the JS picks
  up all `.beam` elements on load.

## Known follow-ups / cautions
- **Testimonials are placeholder/illustrative** (fake names + quotes). Replace with real
  ones before any public launch.
- Stats in the hero (2M+ citations, 99%, etc.) are marketing placeholders.
- `.beam`'s `mask-composite` border technique is best in **Chromium**; Safari/Firefox
  degrade gracefully but may look slightly different.
- No deploy pipeline exists. If asked to publish, every host needs the user's account —
  confirm the platform (Netlify/Vercel/etc.) first; don't assume.

## Working style for this project
The user iterates rapidly on visual feel and often pastes **React/shadcn component code**
to "incorporate" — port the *effect* to vanilla HTML/CSS/JS (no React), keep the existing
theme, and apply it where they specify. Make the change, verify the server returns 200,
tell them to hard-reload (Ctrl+F5, since `app.js` caches), and offer the one or two tuning
knobs that matter. Be concrete about trade-offs; don't re-do settled decisions.

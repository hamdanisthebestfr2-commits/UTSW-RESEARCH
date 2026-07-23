# CLAUDE.md — REF/CHECK AI

> Read this first. It's the single source of truth for what this project is, how it's
> architected, how to run/deploy it, and the non-obvious gotchas. If you're a fresh Claude
> session on a new machine, this file should get you fully oriented.

> **ARCHITECTURE CHANGE (2026-07-23): the app is now 100% client-side. Supabase, login, and the
> Deno Edge Function are GONE.** No account, no cloud, nothing uploaded to a server of ours. The old
> `verify` Edge Function was fully ported into the browser as **`refcheck-core.js`**; existence checks
> hit the public APIs directly (CORS-enabled, no key), and Gemini is called straight from the browser
> with the **user's own API key** (stored in `localStorage`). History is saved in `localStorage` too.

## What this is
**REF/CHECK AI** — an AI-powered academic manuscript / reference verification platform.
A user uploads a manuscript (PDF or DOCX); the app extracts every citation, verifies each
reference's **existence** against **CrossRef + PubMed + OpenAlex + DataCite + Google Books + Internet
Archive**, uses **Gemini** (user's key) to judge plausibility (real vs. fabricated), and shows a polished,
animated report: the manuscript text with **in-text citations highlighted** and **linked** to a panel of
reference cards.

Beyond that core (Phases 1–2), the app now implements:
- **Phase 3 — AI citation checking**: upload the cited source PDFs, auto-match them to references, and
  have Gemini judge whether each in-text claim is **SUPPORTED / PARTIAL / NOT SUPPORTED / UNCLEAR**, with a
  **Broad vs. Critical** strictness selector (falls back to the paper's abstract when no PDF). The source
  card shows the article's claim next to a verbatim source passage. **A confirmed source whose claim isn't
  supported flags the reference as a citation error — identity-confirmed ≠ correctly-cited.** Plus CSV +
  Word-report export and a manual "flag for review".
- **Phase 4 — feedback**: thumbs up/down on every result, saved **locally** with the analysis. (The old
  Supabase admin dashboard was removed with the backend.)
- **Phase 5 (partial) — stretch**: **batch** multi-manuscript processing with a queue, and a client-side
  **reference-format consistency** checker. (Teams/shared workspaces — not built; would need a real backend.)

This repo contains **both** the marketing landing page **and** the working app.

## Stack (no build step, no framework, no npm, no backend)
- **Static frontend**: plain HTML/CSS/JS. **Tailwind via CDN** with an inline `tailwind.config`
  in a `<script>` on each page (utility classes are generated at runtime in the browser).
- **No auth, no database, no server.** Everything runs in the browser. Analysis history + settings
  (Gemini key, email, model, daily limit) live in `localStorage`.
- **Core logic**: `refcheck-core.js` — the ported "verify" pipeline. Existence checks call CrossRef,
  PubMed, OpenAlex, DataCite, Google Books, and the Wayback Machine directly (all CORS-enabled, no key).
  Gemini (`generativelanguage.googleapis.com`) is called from the browser with the **user's own key**.
- **Client-side parsing**: `pdf.js` (PDF) + `mammoth.js` (DOCX), loaded from CDN.
- **Fonts**: Space Grotesk (display), Inter (body), JetBrains Mono (labels/mono), Material Symbols (icons), all via Google Fonts.
- Platform: **Windows / PowerShell**. Git repo: yes (see GitHub section).

## Run it
The app is a static site — serve the folder any way you like. On this machine (no Python) use the
bundled PowerShell server from the parent working folder: `powershell -ExecutionPolicy Bypass -File .\serve.ps1`
(serves `UTSW-RESEARCH-main/` on `http://localhost:8000`). Verify: `(Invoke-WebRequest http://localhost:8000 -UseBasicParsing).StatusCode` → `200`.
Scripts are **cache-busted with `?v=N`** query strings — after editing `app-ui.js` / `refcheck-core.js`,
bump the `?v=` in `app.html`, and hard-reload (**Ctrl+F5**). **There is no backend to deploy.** To use the
AI features, open **Settings** and paste a free Gemini key from aistudio.google.com/apikey.

## File map
| File | Purpose |
|------|---------|
| `index.html` | Landing page. Holds the design system: `tailwind.config` (color/font tokens) + a big `<style>` block with all custom CSS utilities. CTAs now link straight to `app.html` (no login). |
| `app.js` | Landing-page interactions only (one IIFE). NOT used by the app. |
| `app.html` / `app-ui.js` | **The product**: the workspace — upload, extract, analyze, results, source-PDF citation checking, strictness, Settings, feedback, batch, format check. Opens directly (no auth gate). |
| `refcheck-core.js` | **The engine** (`window.RefCheckCore`). Ported from the old Edge Function: reference extraction (Gemini), existence cascade (CrossRef→PubMed→OpenAlex→DataCite→Google Books→Wayback), claim-check (`assessCitation`, with Broad/Critical strictness) and source-PDF match (`assessMatch`). Holds settings + daily-limit in `localStorage`. `run(body)` returns `{data,error}` mirroring the old `sb.functions.invoke("verify",…)`. |
| `refrences/` | A concept screenshot (note the folder is spelled "refrences"). |
| `README.md`, `.gitignore` | Repo basics. |

**Deleted in the 2026-07-23 rewrite** (do not look for these — they're gone): `auth.html`, `auth.js`,
`admin.html`, `admin.js`, `supabase-config.js`, `dashboard.html`, and the entire `supabase/` folder
(the `verify` Edge Function, `config.toml`, `setup_phase3_4.sql`).

## Design language (igloo.inc-inspired, monochrome)
Near-black canvas, white/silver accents, glass surfaces, subtle grain + grid + aurora bloom. The
ONLY broad hue is the **rich-orange cursor glow** on `.beam` cards. Semantic color (green/amber/red)
appears **only** on verification states and is muted.

### Color tokens (in every page's `tailwind.config`)
- Surfaces: `bg #060607`, `bg-soft #0b0b0d`, `surface #101012`, `surface-2 #161618`, `surface-3 #1d1d20`
- Borders: `border-subtle rgba(255,255,255,.09)`, `border-strong rgba(255,255,255,.16)`
- Text: `ink #F4F4F6`, `ink-soft #ADADB6`, `ink-mute #8A8A93`
- Accents (grayscale): `accent #FFFFFF`, `accent-2 #A6A6AE`, `accent-3 #D4D4DA`
- Semantic (muted): `ok #7FC8A0`, `warn #D9B776`, `bad #DB8793`
- Fonts: `display` = Space Grotesk, `body` = Inter, `mono` = JetBrains Mono.

### Key custom CSS utilities
- `.glass` — translucent dark surface + `backdrop-filter: blur` + inner top highlight.
- `.beam` — **rich-orange cursor-tracking spotlight glow border** (hover only). On most cards.
- `.btn-primary` — **white pill at rest → indigo/purple/pink gradient fills the face on hover**,
  text stays dark. Needs `isolation: isolate` so the negative-z `::after` gradient paints over white.
- `.glass-liquid` — lighter frosted variant (secondary buttons).
- `.gradient-text` / `.shimmer-text` — silver gradient / animated silver shimmer.
- `.lift` — hover translateY/shadow (JS tilt overrides transform).
- `.bg-grid`, `.aurora`, `.marquee-track`, `.scanline`, `#spotlight`, `#scroll-progress`.
- Landing platform preview: `.ptab`, `.panel-anim`.
- App results: `.doc-surface` (reading pane), `mark.cite` + `.v-ok/.v-warn/.v-bad` (citation highlights),
  `.ref-card`, `.fchip`/`.ptab-mobile` (filters / mobile pane tabs), `.hl-off` (highlights toggled off).

### The `.beam` glow — IMPORTANT gotchas (ported from a 21st.dev "spotlight-card")
- Tunable vars on `.beam`: `--base:16 --spread:14` (orange hue band — keep it orange), `--size:520`
  (glow radius — bigger triggers from farther), `--border:2`. `::before` = orange ring, `::after` = warm core.
- Border ring uses the `mask` + `mask-composite: exclude` padding trick.
- **DO NOT use `background-attachment: fixed`** (the original technique). Our cards use `backdrop-filter`,
  which makes them a containing block for fixed backgrounds → the glow freezes off-card. Instead the JS
  tracks the pointer **locally per card** (`clientX - rect.left`) and sets `--x/--y/--xp`.
- **DO NOT gate the pointer JS behind `matchMedia("(pointer:fine)")`** — touch-capable Windows laptops
  report a coarse primary pointer even with a mouse, which froze the effect.
- Cards with `.beam` also get a subtle **3D tilt** toward the cursor (and the first/hero landing card is
  intentionally excluded).

## Authentication
**There is none.** The app opens straight into the workspace. (Removed 2026-07-23 — no Supabase, no
Google OAuth, no session gate. If you find yourself reading about `auth.js` or `AUTH_REDIRECT`, that
content is historical.)

## The app (`app.html` + `app-ui.js`)
- **No auth gate**: `app.html` opens directly. Top bar shows a "Runs locally" pill + **Settings** + theme toggle.
- **Shell**: left **sidebar** ("New analysis" + **history list** from `localStorage`), main area with three
  views toggled via inline `display`: **upload → processing → results**. The upload view also hosts the
  **Settings** panel (Gemini key/email/model/daily limit) and a "no key" nudge.
- **Upload**: drag-&-drop + file picker, `.pdf`/`.docx`, ≤20 MB, inline validation.
- **Extraction (client-side, no key)**: `pdf.js` (`pdfjs-dist@3.11.174` UMD; `workerSrc` set) for PDF,
  `mammoth.js` for DOCX. `sliceReferences()` finds the References/Bibliography heading and returns
  `{ slice, bodyEnd }` (only the references slice is sent to the backend; `bodyEnd` bounds highlighting to the body).
- **Analyze**: `sb.functions.invoke("verify", { body:{ filename, referencesText } })` (JWT auto-attached).
  Then `persist()` inserts into `analyses` (incl. `document_text` capped at 300k chars) and renders results.
- **Results = two-pane linked workspace**:
  - Header: animated **integrity ring** (count-up), one-line summary, **stacked proportion bar**, Export CSV.
  - **Left** "Manuscript": the body text on `.doc-surface`, with **in-text citations highlighted**, colored by
    the cited reference's verdict; highlight on/off toggle; legend.
  - **Right** "References": filter chips (All/Verified/Review/Flagged) + rich **reference cards** (verdict chip,
    authors·year·journal, CrossRef **matched title** + DOI link, AI reason, **confidence bar**, **"Cited N×"**).
  - **Linked both ways**: click a reference → its marks spotlight (others dim) + scroll into view; click a
    highlight → jump to its card. Mobile collapses to **Manuscript / References tabs** that auto-switch.
- **Highlight engine** (`renderDocument` in `app-ui.js`): **numbered** styles match bracketed/parenthesised
  digit groups (`[1]`, `[1-3]`, `[1,2]`) mapped via each reference's `marker`; **author-year** styles match
  first-author surname within ~32 chars of the year. Best-effort — unmatched refs show "Not found in text".
  Bare superscript numbers are intentionally skipped (too noisy).
- **History**: clicking a past analysis rebuilds the full view (incl. the highlighted document, since
  `document_text` is stored). `loadHistory()` falls back gracefully if the `document_text` column is missing.

## The engine — `refcheck-core.js` (`window.RefCheckCore`, all in the browser)
The old Deno Edge Function was ported here verbatim in logic; the only real changes are (a) no server
env — settings come from `localStorage`; (b) no custom `User-Agent` header (browsers forbid it) — polite-pool
identification uses the `mailto`/`email` query param instead; (c) the arbitrary-URL web fetch (CORS-blocked
in a browser) was swapped for a **Wayback Machine availability** check.
- **Settings** (`getSettings`/`saveSettings`, `localStorage` key `refcheck-settings`): `{ geminiKey, email,
  model (default gemini-2.5-flash), dailyLimit (default 200) }`. `usageToday()` tracks the day's Gemini calls;
  `bumpUsage()` enforces the daily limit. `detectModels()` lists usable Gemini models for the key.
- **`run(body)` → `{ data, error }`** (mirrors the old `sb.functions.invoke("verify", …)`; `app-ui.js` calls
  `Core.run(...)`). Actions:
  - **default (verify)** — `{ filename, referencesText }`. Gemini `analyzeReferences` (chunked, temp 0 + seed 7)
    → refs; existence via **`verifyExistence`** cascade CrossRef→PubMed→OpenAlex→DataCite→Google Books→Wayback,
    then `reconcile`. Returns `{ filename, total, counts, integrityScore, citationStyle, references[] }`.
  - **`action:"cite"`** — `{ claim, paperText, paperTitle, basis, strictness }` → `assessCitation`
    → `{ assessment, explanation, sourceQuote, basis }`. **`strictness`** is `"broad"` (defensible readings pass)
    or `"critical"` (also flags overstatement).
  - **`action:"match"`** — `{ paperText, ref }` → `assessMatch` (is this uploaded PDF the cited work?)
    → `{ verdict (confirmed|partial|mismatch), explanation, foundTitle/Authors/Year, evidence[] }`.
- **Gemini** is called at `generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=…` with
  the user's key. Existence APIs (CrossRef, NCBI eutils, OpenAlex, DataCite, Google Books, archive.org) are all
  CORS-enabled and need **no key**. Retraction: PubMed pub-type + OpenAlex `is_retracted` (+ DOI probe).

### Gemini model notes
- Use **`gemini-2.5-flash`** (good quality, free tier) or `gemini-2.5-flash-lite` (cheaper). `gemini-2.0-flash`
  had no free-tier quota. The Settings "Detect available models" button lists what the user's key can use.
- The user pastes their own key in **Settings**; it lives only in their browser's `localStorage`. Nothing is
  proxied through any server of ours.

## Storage (browser `localStorage` — no database)
- `refcheck-analyses` — array (cap 50) of past analyses: `{ id, filename, integrity_score, counts, results,
  citation_results, feedback, document_text, created_at }`. Powers the sidebar history and the highlighted
  rebuild. Managed by `loadStore`/`storeUpsert`/`storeGet` in `app-ui.js`.
- `refcheck-settings` (see above), `refcheck-usage` (daily counter), `refcheck-strictness`, `refcheck-theme`.
- Thumbs feedback is stored **inside each analysis record** (`.feedback`), not a separate table.

## Deploy
**Nothing to deploy** — it's a static site with no backend. Serve the folder (locally, `serve.ps1`) or host
the static files anywhere (Netlify/Vercel/GitHub Pages). Each user brings their own Gemini key via Settings.

## GitHub
- Remote: **https://github.com/hamdanisthebestfr2-commits/UTSW-RESEARCH** (`origin`, branch `main`).
- Repo-local git identity: `Hamdan <ibrahimosman123cc@gmail.com>`.
- Routine push: `git add -A && git commit -m "..." && git push`. End commit messages with the
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Conventions & gotchas
- **Tailwind `hidden` vs `flex`/`grid` conflict**: don't combine on toggled elements. App views, platform
  panels, and results panes toggle via inline `style.display`, not the `hidden` class.
- **Gradient buttons** need `isolation: isolate` + a negative-z `::after`.
- **Material Symbols only, never emoji.** One icon family throughout.
- **Accessibility**: white `:focus-visible` outlines, `prefers-reduced-motion` guards, body contrast ≥4.5:1
  (why `ink-mute` is lightened). Keep these.
- When **adding a landing section with an id**, update the nav links (desktop + mobile) AND the `sections`
  array in `app.js` (scrollspy).
- When adding a card that should glow+tilt, just give it the `beam` class — the JS picks up all `.beam` on load.

## Known follow-ups / cautions
- **Landing testimonials + hero stats are placeholders** — replace before any public launch.
- Highlight matching is **best-effort** (messy PDFs / unusual styles may miss marks; refs still display).
- No deploy pipeline — static site. To publish, host the files anywhere; each user brings their own Gemini key.
- **Cache-buster** after editing `app-ui.js`/`refcheck-core.js`: bump `?v=` in `app.html` (currently
  `app-ui.js?v=26`, `refcheck-core.js?v=1`), hard-reload Ctrl+F5.
- Results open with a **plain-language "teacher summary" verdict banner** (`#verdict-banner`,
  `teacherVerdict()`/`renderVerdictBanner()`): **reliable / review recommended / unreliable** — folded into the `.doc` report.
- **Verified ≠ correctly-cited**: a source PDF confirmed as reference [N] proves the paper is real, but if the
  claim citing it comes back `not_supported`, `applySourceEvidence()` **flags** that reference (citation error)
  rather than marking it verified. `partial` → review.
- **Still open / next ideas**: OCR for scanned source PDFs; persisting matched source-PDF text (today only the
  citation *assessments* persist in `localStorage`, not the PDFs — re-checking after reload needs re-upload);
  a shared `theme.css`; optional cross-device sync would require re-introducing a backend.

## Working style for this project
The user iterates fast on visual feel and often pastes **React/shadcn component code** to "incorporate" —
port the *effect* to vanilla HTML/CSS/JS (no React), keep the existing theme, apply where specified. Make the
change, verify the server returns 200, tell them to hard-reload (Ctrl+F5), and offer the one or two tuning
knobs that matter. Be concrete about trade-offs; don't re-litigate settled decisions.

# CLAUDE.md — REF/CHECK AI

> Read this first. It's the single source of truth for what this project is, how it's
> architected, how to run/deploy it, and the non-obvious gotchas. If you're a fresh Claude
> session on a new machine, this file should get you fully oriented.

## What this is
**REF/CHECK AI** — an AI-powered academic manuscript / reference verification platform.
A user uploads a manuscript (PDF or DOCX); the app extracts every citation, verifies each
reference's **existence** against CrossRef, uses **Gemini** to judge plausibility (real vs.
fabricated), and shows a polished, animated report: the manuscript text with **in-text citations
highlighted** and **linked** to a panel of reference cards.

This repo contains **both** the marketing landing page **and** the working app.

## Stack (no build step, no framework, no npm)
- **Static frontend**: plain HTML/CSS/JS. **Tailwind via CDN** with an inline `tailwind.config`
  in a `<script>` on each page (utility classes are generated at runtime in the browser).
- **Auth + database**: **Supabase** (email/password + Google OAuth; per-user analysis history with RLS).
- **Backend**: a single **Supabase Edge Function** (Deno) at `supabase/functions/verify` that holds
  the Gemini API key as a server-side secret and calls Gemini + CrossRef. **The key never reaches the browser.**
- **Client-side parsing**: `pdf.js` (PDF) + `mammoth.js` (DOCX), loaded from CDN.
- **Fonts**: Space Grotesk (display), Inter (body), JetBrains Mono (labels/mono), Material Symbols (icons), all via Google Fonts.
- Platform: **Windows / PowerShell**. Git repo: yes (see GitHub section).

## Run it
```bash
python -m http.server 8000      # from the project root
# open http://localhost:8000
```
Stop: `Stop-Process -Name python`. Verify a change: `(Invoke-WebRequest http://localhost:8000 -UseBasicParsing).StatusCode` → expect `200`.
Scripts are **cache-busted with `?v=N`** query strings — after editing `app-ui.js` / `auth.js` /
`supabase-config.js`, bump the `?v=` in the referencing HTML, and hard-reload (**Ctrl+F5**).

## File map
| File | Purpose |
|------|---------|
| `index.html` | Landing page. Holds the design system: `tailwind.config` (color/font tokens) + a big `<style>` block with all custom CSS utilities. |
| `app.js` | Landing-page interactions only (one IIFE). NOT used by the app. |
| `auth.html` / `auth.js` | Login / signup page (email/password + Google), themed. |
| `app.html` / `app-ui.js` | **The product**: gated workspace — upload, extract, analyze, results. |
| `supabase-config.js` | Supabase URL + publishable key + `AUTH_REDIRECT` + `AUTH_TESTING` flag. Loaded by auth/app pages. |
| `supabase/functions/verify/index.ts` | **Edge Function** — Gemini + CrossRef. The only place the Gemini key is used (via env). |
| `supabase/functions/verify/deno.json`, `supabase/config.toml` | Function scaffolding; `config.toml` sets `verify_jwt = true`. |
| `dashboard.html` | **Legacy/unused** earlier placeholder; post-login redirect goes to `app.html`, not here. |
| `refrences/` | A concept screenshot (note the folder is spelled "refrences"). |
| `README.md`, `.gitignore` | Repo basics. |

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

## Authentication (Supabase)
- **Project ref**: `emzssipjrkknheomfjem` · **API URL**: `https://emzssipjrkknheomfjem.supabase.co`
- `supabase-config.js` holds the **publishable (anon) key** — safe to expose; RLS protects data. Also
  `window.AUTH_REDIRECT = origin + "/app.html"` and `window.AUTH_TESTING` (see below).
- `auth.js`: email/password (`signUp`, `signInWithPassword`) + Google (`signInWithOAuth({provider:'google', redirectTo: AUTH_REDIRECT})`).
  Errors are surfaced **on the page** (red box). Sign in ⇄ Create account toggle; `?mode=signup` deep link.
- **Google OAuth setup** (already configured): in Google Cloud the OAuth client's **Authorized redirect URI**
  must be the Supabase callback `https://emzssipjrkknheomfjem.supabase.co/auth/v1/callback` (NOT localhost/app.html).
  In Supabase → Auth → URL Configuration: **Site URL** `http://localhost:8000`, **Redirect URLs** include
  `http://localhost:8000/app.html`.
- **"Confirm email"**: if ON in Supabase, email signup sends a confirmation link instead of logging in
  immediately (the page says "check your inbox"). Toggle OFF (Auth → Providers → Email) for instant testing.
- `window.AUTH_TESTING` (currently **false**): when `true`, loading `auth.html` signs you out and `app.html`
  logs you out on reload — a loop for re-testing login. Set `false` for normal persisted sessions.
- Landing buttons: "Log in" → `auth.html`; "Get Started"/CTAs → `auth.html?mode=signup`.

## The app (`app.html` + `app-ui.js`)
- **Auth gate**: no Supabase session → redirect to `auth.html`.
- **Shell**: top bar (logo, user email/avatar, Sign out), left **sidebar** ("New analysis" + **history list**
  from the `analyses` table), main area with three views toggled via inline `display`: **upload → processing → results**.
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

## Backend — Edge Function `verify` (`supabase/functions/verify/index.ts`)
- **Deno**, **JWT-protected** (`verify_jwt = true`) so only logged-in users can spend the key.
- **Env**: `GEMINI_API_KEY` (secret — the ONLY place the key exists), `GEMINI_MODEL` (default `gemini-2.5-flash`).
- **Input** `{ filename, referencesText }`; caps: 60k input chars, `MAX_REFS` 40, CrossRef concurrency 5.
- **One Gemini call** with a JSON `responseSchema` → `{ citationStyle, references[] }`; each ref has
  `raw, authors, title, year, journal, doi, marker, verdict (verified|review|flagged), confidence, reason`.
- **CrossRef** per reference (DOI lookup, else bibliographic query; title similarity ≥ 0.6) → `exists`,
  `doi`, `crossrefUrl`, `matchedTitle`.
- **Reconcile** Gemini verdict + CrossRef existence; `integrityScore = round(100*(verified + 0.5*review)/total)`.
- **Returns** `{ filename, total, counts, integrityScore, citationStyle, references[] }`. CORS + OPTIONS handled.

### Gemini model notes (learned the hard way)
- `gemini-2.0-flash` returned **429 (no free-tier quota)** on this key. `gemini-2.5-flash` and
  `gemini-2.5-flash-lite` both work → we use **`gemini-2.5-flash`** (good quality, free tier). Switch via the
  `GEMINI_MODEL` secret/env to `gemini-2.5-flash-lite` to cut cost.
- The provided key starts `AQ.…` (unusual; standard AI Studio keys are `AIzaSy…`). It authenticates fine. If
  it ever fails auth, create a key at aistudio.google.com/apikey and re-run `secrets set` + `deploy` — no code change.

## Database (Supabase Postgres)
Table `public.analyses` (run in Supabase SQL Editor):
```sql
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  filename text not null,
  integrity_score int not null,
  counts jsonb not null,        -- {verified, review, flagged}
  results jsonb not null,       -- array of reference objects (see function output)
  document_text text            -- extracted manuscript text (for the highlighted history view)
);
alter table public.analyses enable row level security;
create policy "own_select" on public.analyses for select using (auth.uid() = user_id);
create policy "own_insert" on public.analyses for insert with check (auth.uid() = user_id);
create policy "own_delete" on public.analyses for delete using (auth.uid() = user_id);
```
(`document_text` was added after the initial table; if migrating: `alter table public.analyses add column if not exists document_text text;`.)

## Deploy / setup the backend (one-time)
The Supabase CLI is **not installed globally**; use `npx`. On Windows PowerShell, `npx` may be blocked by the
execution policy — either `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first, or call `npx.cmd`.
```bash
npx supabase login                                  # interactive (browser)
npx supabase secrets set GEMINI_API_KEY=<key> --project-ref emzssipjrkknheomfjem
npx supabase functions deploy verify --project-ref emzssipjrkknheomfjem
```
`functions deploy` prints a harmless "Docker is not running" warning, then deploys via the API. Passing
`--project-ref` avoids needing `supabase link` (and its DB-password prompt). Smoke test:
`Invoke-WebRequest -Method OPTIONS https://emzssipjrkknheomfjem.supabase.co/functions/v1/verify` → 200.

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
- `dashboard.html` is legacy and unused.
- No deploy pipeline for the static site (runs locally). If asked to publish, confirm the host (Netlify/Vercel)
  — it needs the user's account.
- **Next phase ideas**: upload source PDFs + per-claim "supported by source" check; PubMed alongside CrossRef;
  OCR for scanned PDFs; export/share polish; a shared `theme.css` to stop duplicating the design tokens per page.

## Working style for this project
The user iterates fast on visual feel and often pastes **React/shadcn component code** to "incorporate" —
port the *effect* to vanilla HTML/CSS/JS (no React), keep the existing theme, apply where specified. Make the
change, verify the server returns 200, tell them to hard-reload (Ctrl+F5), and offer the one or two tuning
knobs that matter. Be concrete about trade-offs; don't re-litigate settled decisions.

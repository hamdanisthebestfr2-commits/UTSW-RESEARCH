# REF/CHECK AI

An AI-powered academic manuscript / reference verification platform. Upload a manuscript
(PDF or DOCX) and REF/CHECK extracts every citation, verifies each reference's **existence**
against CrossRef, and uses **Gemini** to judge plausibility — then shows a color-coded
integrity report with the manuscript text and **in-text citations highlighted** and linked to
each reference.

## Stack
- **Frontend**: static `index.html` (landing) + `app.html` (workspace) + `auth.html` (login),
  plain HTML/CSS/JS with Tailwind via CDN. No build step.
- **Auth + DB**: Supabase (email/password + Google OAuth; analyses saved per-user with RLS).
- **Backend**: Supabase Edge Function (`supabase/functions/verify`) — holds the Gemini key as a
  server-side secret and calls Gemini + CrossRef. The key never reaches the browser.
- **Parsing**: pdf.js + mammoth.js extract text client-side.

## Run locally
```bash
python -m http.server 8000
# open http://localhost:8000
```

## Setup (Supabase)
1. Create the `analyses` table (see `supabase/` notes / project SQL) with RLS.
2. Deploy the function and set the secret:
   ```bash
   npx supabase secrets set GEMINI_API_KEY=<your key> --project-ref <ref>
   npx supabase functions deploy verify --project-ref <ref>
   ```
3. Put your Supabase URL + publishable key in `supabase-config.js`.

See `CLAUDE.md` for full architecture, design system, and conventions.

// ============================================================
// REF/CHECK — `verify` Edge Function (Deno)
// Holds the Gemini API key server-side (secret), never exposed to the browser.
// Flow: receives the manuscript's References text → Gemini extracts + judges each
// reference → CrossRef confirms existence → reconcile into a scored report.
// ============================================================

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const CONTACT_EMAIL = Deno.env.get("CONTACT_EMAIL") ?? "support@ref-check.ai";
const PUBMED_API_KEY = Deno.env.get("PUBMED_API_KEY") ?? ""; // optional: raises NCBI rate limit
const MAX_CHARS = 200_000;  // allow very large bibliographies (extraction is chunked below)
const MAX_REFS = 150;       // existence-check up to this many refs; overflow is kept, not dropped
const CHUNK_CHARS = 14_000; // per-Gemini extraction slice — small enough to read every entry faithfully
const EXTRACT_CONCURRENCY = 3; // parallel Gemini extraction calls for large bibliographies
const VERIFY_CONCURRENCY = 8; // existence checks (CrossRef + PubMed + web) in parallel
// Determinism: temperature 0 + a fixed seed on every Gemini call so the SAME manuscript yields the
// SAME references (and the same verdicts) on every run — no more drifting reference counts.
const GEN_SEED = 7;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- types ----
interface GeminiRef {
  id: number;
  raw: string;
  authors?: string;
  title?: string;
  year?: string;
  journal?: string;
  doi?: string;
  url?: string;
  marker?: string;
  verdict?: "verified" | "review" | "flagged";
  confidence?: number;
  reason?: string;
}

interface GeminiResult {
  citationStyle: "numbered" | "author-year" | "unknown";
  references: GeminiRef[];
}

// ---- Gemini: extract + judge one chunk of the bibliography in a single structured call ----
async function extractChunk(referencesText: string): Promise<GeminiResult> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are an academic integrity assistant. Below is part of the References/Bibliography
section of a manuscript. Determine the citation style and extract EVERY individual reference, analyzing each.
Read the entire excerpt end to end and do not skip, merge, summarize, or invent references — extract exactly
the references that are written here, each one exactly once.

First decide citationStyle:
- "numbered": references are numbered (1., [1], (1)…) and cited in-text as [1]/(1)/superscripts
- "author-year": references have no numbers and are cited in-text as (Surname, Year)
- "unknown": cannot tell

For each reference return:
- raw: the full reference string as written
- authors, title, year, journal, doi (best-effort parse; empty string if absent)
- url: the web link if the reference includes one (news articles, websites, reports, "Available at:",
  "Retrieved from", "Accessed" URLs). Include the full http(s) URL. Empty string if there is none.
- marker: the token used to find this reference IN THE BODY TEXT. For numbered style use the
  reference's number only (e.g. "12"). For author-year use "Surname YEAR" using the FIRST author's
  surname and the year (e.g. "Smith 2020"). Empty string if unknown.
- verdict: one of "verified" | "review" | "flagged"
    • "verified": looks like a real, well-formed, plausible publication
    • "review": real-looking but with inconsistencies, missing info, or details that don't add up
    • "flagged": likely fabricated/hallucinated (implausible authors+title+venue combo, fake-looking DOI, nonsensical)
- confidence: 0..1 for your verdict
- reason: a specific, evidence-based explanation of the verdict.
    - For "flagged" or "review": QUOTE the exact text from THIS reference that concerns you — copy the
      problematic fragment inside double quotes — and explain precisely what is wrong or unusual. For
      example: the DOI "10.9999/not-a-real-doi" is malformed; or the journal "Journal of Quantum Botany"
      would not plausibly publish this clinical topic; or the author/title/venue combination is internally
      inconsistent. Be concrete and point at the actual words. 2 to 4 sentences.
    - For "verified": one short sentence is enough.

IMPORTANT judging rules (this tool is used by researchers; a wrong "flagged" is very costly):
- Today's date is ${today}. References dated up to and including the current year are valid — NEVER flag a
  reference merely because its year looks recent or "in the future" relative to what you remember.
- References are not only journal articles. Books, book chapters, conference papers, preprints
  (arXiv/bioRxiv/SSRN), theses/dissertations, datasets, software, standards, government or organizational
  reports, and news/media articles (e.g. Al Jazeera, Reuters, BBC, NYT) are ALL legitimate references.
  Do NOT flag a reference just because it is not a journal article, has no DOI, is a news/web source, or
  is unfamiliar to you — most real references cannot be memorized.
- Use "flagged" ONLY when the reference is internally contradictory or shows concrete signs of being
  fabricated/hallucinated (e.g. an author+title+venue combination that could not plausibly coexist, or an
  obviously fake identifier). If you are not confident it is fabricated, use "review", never "flagged".
- Existence in a database is checked separately by the system; do not assume a reference is fake just
  because you personally cannot recall it.

References section:
"""${referencesText}"""`;

  const schema = {
    type: "OBJECT",
    properties: {
      citationStyle: { type: "STRING", enum: ["numbered", "author-year", "unknown"] },
      references: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            raw: { type: "STRING" },
            authors: { type: "STRING" },
            title: { type: "STRING" },
            year: { type: "STRING" },
            journal: { type: "STRING" },
            doi: { type: "STRING" },
            url: { type: "STRING" },
            marker: { type: "STRING" },
            verdict: { type: "STRING", enum: ["verified", "review", "flagged"] },
            confidence: { type: "NUMBER" },
            reason: { type: "STRING" },
          },
          required: ["raw", "verdict", "reason"],
        },
      },
    },
    required: ["citationStyle", "references"],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        seed: GEN_SEED,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: GeminiResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Could not parse the model's response.");
  }
  const refs = (Array.isArray(parsed?.references) ? parsed.references : []).map((r, i) => ({ ...r, id: i + 1 }));
  return { citationStyle: parsed?.citationStyle ?? "unknown", references: refs };
}

// Split a bibliography into reference-aligned entries so each Gemini call sees a bounded, COMPLETE
// slice. This is what keeps extraction faithful on very large papers (hundreds of references): the
// model reads every entry instead of truncating or dropping the tail of a huge list.
function segmentReferences(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const numbered = /^\s*(\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+\S/;      // 1.  [1]  (1)
  const authorYear = /^\s*[A-Z][A-Za-z'’-]+,\s+[A-Z]\.?/;                 // Surname, X
  const entries: string[] = [];
  let cur = "", starts = 0;
  for (const ln of lines) {
    const isStart = numbered.test(ln) || authorYear.test(ln);
    if (isStart && cur.trim()) { entries.push(cur.trim()); cur = ln; starts++; }
    else cur = cur ? cur + "\n" + ln : ln;
  }
  if (cur.trim()) entries.push(cur.trim());
  // too few detectable boundaries -> let the char-window packer handle it
  return starts >= 3 ? entries : [text];
}

// Pack the bibliography into <= CHUNK_CHARS pieces, always breaking BETWEEN references (or, failing
// that, on a newline) so no single reference is ever split across two chunks and lost.
function packChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const entries = segmentReferences(text);
  if (entries.length > 1) {
    const chunks: string[] = [];
    let buf = "";
    for (const e of entries) {
      if (buf && buf.length + e.length + 1 > CHUNK_CHARS) { chunks.push(buf); buf = e; }
      else buf = buf ? buf + "\n" + e : e;
    }
    if (buf) chunks.push(buf);
    return chunks;
  }
  // no reliable reference boundaries — window on newlines
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + 1000) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

// Extract + judge the FULL bibliography by chunking, running the chunks with limited concurrency,
// then merging and de-duplicating so every reference is analyzed exactly once.
async function analyzeReferences(text: string): Promise<GeminiResult> {
  const chunks = packChunks(text);
  if (chunks.length === 1) return await extractChunk(chunks[0]);

  const results: (GeminiResult | null)[] = new Array(chunks.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const i = idx++;
      try { results[i] = await extractChunk(chunks[i]); }
      catch { results[i] = { citationStyle: "unknown", references: [] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, chunks.length) }, worker));

  const seen = new Set<string>();
  const merged: GeminiRef[] = [];
  const styleVotes: Record<string, number> = {};
  for (const r of results) {
    if (!r) continue;
    styleVotes[r.citationStyle] = (styleVotes[r.citationStyle] ?? 0) + 1;
    for (const ref of r.references) {
      const key = normalizeTitle(ref.raw || ref.title || "").slice(0, 140);
      if (!key || seen.has(key)) continue; // drops overlap/duplicate entries, never real ones
      seen.add(key);
      merged.push(ref);
    }
  }
  const citationStyle = (["numbered", "author-year", "unknown"] as const)
    .sort((a, b) => (styleVotes[b] ?? 0) - (styleVotes[a] ?? 0))[0];
  return { citationStyle, references: merged.map((r, i) => ({ ...r, id: i + 1 })) };
}

// ---- Phase 3: AI citation checking (claim vs. cited paper) ----
const MAX_CITE_CHARS = 60_000; // read a large span of the cited paper so nothing relevant is missed

type Assessment = "supported" | "partial" | "not_supported" | "unclear";

async function assessCitation(
  claim: string,
  paperText: string,
  paperTitle: string,
  basis: "full text" | "abstract",
): Promise<{ assessment: Assessment; explanation: string; sourceQuote: string }> {
  const source = paperText.slice(0, MAX_CITE_CHARS);
  const prompt = `You are a meticulous scientific citation checker. Below is a claim made in a manuscript
and the text of the paper that was cited to support it (this is the paper's ${basis}).

CLAIM FROM MANUSCRIPT: """${claim}"""
CITED PAPER${paperTitle ? ` ("${paperTitle}")` : ""} ${basis.toUpperCase()}: """${source}"""

Your job: find the ACTUAL passage in the cited paper that bears on this claim, quote a substantial
chunk of it word for word, and judge whether the paper really supports what the manuscript says.

Steps:
1. Break the claim into its concrete checkable assertions — sample/enrollment sizes, population or
   setting, the intervention and its parameters (doses, temperatures, durations, timing), comparisons,
   the outcome plus its DIRECTION and SIGNIFICANCE, and any stated nuance or subgroup finding.
2. Search the paper for the passage that actually addresses them, and copy it VERBATIM into "sourceQuote".
   Quote a MEANINGFUL CHUNK — a full paragraph, or several consecutive sentences (roughly 2 to 6 sentences,
   about 40 to 120 words) — not a lone fragment. It must be one contiguous block of the paper's real text
   that a reader could Ctrl+F and find, and it must contain the actual numbers, findings, or wording that
   the claim stands or falls on. Copy the exact words from the paper; do NOT paraphrase, stitch together
   distant sentences, shorten with "...", or invent text. If the paper genuinely says nothing relevant,
   quote the closest related paragraph you can find (still verbatim) in sourceQuote, or "" if there is
   truly none.

Choose exactly one assessment:
- "supported": the paper clearly backs up the claim's substance (paraphrase and implied support are fine)
- "partial": the paper supports part of it, OR the manuscript overstates, oversimplifies, mismatches a
  number, or omits a key caveat
- "not_supported": the paper does not support the claim, contradicts it, or never addresses it
- "unclear": the provided text is insufficient to tell

Then write "explanation" (about 3 to 5 sentences) that speaks directly to the reader and explicitly puts
the manuscript's claim SIDE BY SIDE with the quoted passage — as if pointing at both on screen:
- If supported: say plainly that the manuscript's claim lines up with the source, and point to the exact
  matching figures/wording in the quote (e.g. "the article says X, and the source says the same — right
  here: ...").
- If partial: say what the manuscript got right AND exactly what it overstated, mismatched, or left out —
  quote the article's version vs. the source's real number/wording so the gap is obvious.
- If not_supported: say clearly the source does not support the claim — state whether the claim is
  exaggerated, distorted, or simply absent — and spell out what the source ACTUALLY says instead, pointing
  right at the quoted passage.
- Always use the paper's real numbers, values, and terms. Be specific and concrete, never vague. Do not
  invent anything that is not in the provided text.`;

  const schema = {
    type: "OBJECT",
    properties: {
      assessment: { type: "STRING", enum: ["supported", "partial", "not_supported", "unclear"] },
      sourceQuote: { type: "STRING" },
      explanation: { type: "STRING" },
    },
    required: ["assessment", "explanation"],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, seed: GEN_SEED, responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: { assessment?: Assessment; explanation?: string; sourceQuote?: string };
  try { parsed = JSON.parse(text); } catch { throw new Error("Could not parse the model's response."); }
  const assessment = (["supported", "partial", "not_supported", "unclear"] as const)
    .includes(parsed?.assessment as Assessment) ? (parsed!.assessment as Assessment) : "unclear";
  return {
    assessment,
    explanation: (parsed?.explanation ?? "").trim(),
    sourceQuote: (parsed?.sourceQuote ?? "").trim(),
  };
}

// ---- Phase 3b: source-PDF identity verification (is this uploaded PDF actually the cited work?) ----
// Reads the ENTIRE uploaded PDF and, grounded in its real text, decides whether it is the same work as
// the reference — quoting the PDF's own title/authors/year back as evidence (NotebookLM-style), rather
// than the old keyword-overlap heuristic. Only a "confirmed" verdict may upgrade a reference's score.
const MAX_MATCH_CHARS = 200_000; // effectively the whole source PDF (gemini-2.5-flash has a huge context)

interface MatchRef {
  title?: string; authors?: string; year?: string; journal?: string; raw?: string; doi?: string;
}
type MatchVerdict = "confirmed" | "partial" | "mismatch";

async function assessMatch(ref: MatchRef, paperText: string): Promise<{
  verdict: MatchVerdict; explanation: string;
  foundTitle: string; foundAuthors: string; foundYear: string; evidence: string[];
}> {
  const source = paperText.slice(0, MAX_MATCH_CHARS);
  const prompt = `You are verifying whether an uploaded PDF IS the exact work that a manuscript cited in one
of its references. Read the ENTIRE PDF below — its title page, headers, author block, abstract, and body —
determine what the PDF actually is, then compare it to the reference.

REFERENCE AS WRITTEN IN THE MANUSCRIPT:
- Title: "${ref.title ?? ""}"
- Authors: "${ref.authors ?? ""}"
- Year: "${ref.year ?? ""}"
- Journal/Source: "${ref.journal ?? ""}"
- DOI: "${ref.doi ?? ""}"
- Full reference string: "${ref.raw ?? ""}"

UPLOADED PDF (full extracted text):
"""${source}"""

First, read out what the PDF itself says it is: copy its actual title verbatim, its actual author list, and
its actual year/publication, straight from the PDF text. Do not guess — use the words that appear in the PDF.

IMPORTANT about the DOI: the DOI shown in the reference above may have been filled in automatically by a
bibliographic database lookup rather than taken from the manuscript, so it can point at a different record.
Treat TITLE, AUTHORS and YEAR as the authoritative identity signals. If those agree, a differing or missing
DOI is NOT by itself a reason to downgrade the verdict — return "confirmed" and simply mention the DOI
difference in the explanation.

Then choose exactly one verdict:
- "confirmed": the PDF is unmistakably the SAME work as the reference (title matches, and the authors and/or
  year corroborate). Minor formatting or punctuation differences are fine, as is a mismatched DOI when the
  title, authors and year all agree.
- "partial": probably the same work but with a real substantive discrepancy in TITLE, AUTHORS or YEAR (e.g.
  the author list or the year differs, or the title is close but not identical). Explain the exact
  discrepancy. Do not use "partial" for a DOI-only difference.
- "mismatch": the PDF is a DIFFERENT work than the reference, or there is not enough evidence that it is the
  same work.

Then write a SPECIFIC explanation (3 to 6 sentences) that SHOWS YOUR WORK by quoting the PDF directly:
- Quote the PDF's real title exactly as it appears, inside double quotes.
- Quote the PDF's author line / affiliation and the year or DOI as they appear in the PDF.
- State precisely how each of these lines up with, or differs from, the reference (title, authors, year).
- If it is a mismatch, name what the PDF is actually about instead.
- Never invent text that is not present in the PDF above.

Also return:
- foundTitle: the PDF's real title, copied verbatim from the PDF (empty string only if truly none is present)
- foundAuthors: the PDF's real author list, from the PDF
- foundYear: the PDF's real year, from the PDF
- evidence: an array of 2 to 4 SHORT verbatim quotes copied from the PDF above that justify the verdict
  (e.g. the title line, the author line, a DOI, the abstract's first sentence). Copy them exactly.`;

  const schema = {
    type: "OBJECT",
    properties: {
      verdict: { type: "STRING", enum: ["confirmed", "partial", "mismatch"] },
      explanation: { type: "STRING" },
      foundTitle: { type: "STRING" },
      foundAuthors: { type: "STRING" },
      foundYear: { type: "STRING" },
      evidence: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["verdict", "explanation"],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, seed: GEN_SEED, responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: {
    verdict?: MatchVerdict; explanation?: string;
    foundTitle?: string; foundAuthors?: string; foundYear?: string; evidence?: unknown;
  };
  try { parsed = JSON.parse(text); } catch { throw new Error("Could not parse the model's response."); }
  const verdict: MatchVerdict = (["confirmed", "partial", "mismatch"] as const)
    .includes(parsed?.verdict as MatchVerdict) ? (parsed!.verdict as MatchVerdict) : "mismatch";
  const evidence = Array.isArray(parsed?.evidence)
    ? (parsed.evidence as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4)
    : [];
  return {
    verdict,
    explanation: (parsed?.explanation ?? "").trim(),
    foundTitle: (parsed?.foundTitle ?? "").trim(),
    foundAuthors: (parsed?.foundAuthors ?? "").trim(),
    foundYear: (parsed?.foundYear ?? "").trim(),
    evidence,
  };
}

// ---- CrossRef / PubMed existence check ----
function normalizeTitle(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Common words that carry little identifying signal in a title. Removing them keeps
// title matching robust to subtitles/boilerplate without diluting the real overlap.
const STOP = new Set(
  (// articles / conjunctions / prepositions
    "the a an and or but nor for to of in on at by from with as into over under between within across " +
    "through during before after above below up down out off about against among per via " +
    // auxiliaries / copulas / pronouns / determiners (function words carry little identifying signal)
    "is are was were be been being am do does did done has have had having will would can could may might " +
    "must shall should this that these those there here it its i we you he she they me us him her them my " +
    "our your his their one two also however therefore thus hence not no such same each any some all both " +
    // generic academic filler
    "using used use new toward towards approach method study analysis based effect role case report review results data")
    .split(" "),
);
function titleTokens(s: string, keepStop = false): string[] {
  const t = normalizeTitle(s).split(" ").filter(Boolean);
  const content = t.filter((w) => !STOP.has(w) && w.length > 1);
  // if stripping stopwords leaves too little (very short titles), fall back to all tokens
  return keepStop || content.length < 2 ? t : content;
}

// First author's surname (best-effort) for bibliographic corroboration.
function surname(authors?: string): string {
  if (!authors) return "";
  const first = authors.split(/;|,|\band\b|&/)[0].trim();
  const parts = first.split(/\s+/).filter(Boolean);
  const cap = parts.find((p) => /^[A-Z][a-z]+/.test(p) && p.length > 2);
  return normalizeTitle(cap || parts[parts.length - 1] || "");
}

// Author-aware match. A real citation's first author appears in the DB record; a fabricated
// reference's invented authors do not. Accept iff EITHER
//  (a) author corroborates + moderate title overlap (surname match, Dice >= 0.6, >= 3 shared words), OR
//  (b) the title alone is NEAR-IDENTICAL (Dice >= 0.8 AND >= 4 shared content words), OR
//  (c) short near-identical titles (<= 4 content words, Dice >= 0.85), OR
//  (d) first-author surname AND year match, plus >= 1 shared title word (for terse titles).
// Phrase-stitched fakes ("<real title> for <new topic>") can't reach the high title-only bar and
// their authors match no real record, so they fail every path.
function acceptMatch(
  ref: GeminiRef,
  candTitle: string,
  candFamilies: string[] = [],
  candYear = "",
): { ok: boolean; score: number } {
  const A = new Set(titleTokens(ref.title ?? "")), B = new Set(titleTokens(candTitle));
  if (!A.size || !B.size) return { ok: false, score: 0 };
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const wantSur = surname(ref.authors);
  const wantYr = String(ref.year || "").match(/\d{4}/)?.[0];
  const fams = candFamilies.map((f) => normalizeTitle(f)).filter(Boolean);
  const surMatch = !!wantSur && fams.includes(wantSur);
  const yrMatch = !!wantYr && String(candYear).includes(wantYr);
  let ok = false;
  if (surMatch && dice >= 0.6 && inter >= 3) ok = true;
  else if (dice >= 0.8 && inter >= 4) ok = true;
  else if (A.size <= 4 && B.size <= 4 && dice >= 0.85) ok = true;
  else if (surMatch && yrMatch && inter >= 1) ok = true;
  return { ok, score: dice };
}

// A reference's existence is confirmed by CrossRef OR PubMed OR OpenAlex OR DataCite OR Google Books
// OR (for news/websites) a live web check. The extra scholarly indexes exist precisely so that
// books, theses, preprints, conference papers, reports and non-indexed-journal articles — which
// CrossRef/PubMed often miss — still get POSITIVELY confirmed instead of falling to "review".
type ExistenceSource = "crossref" | "pubmed" | "openalex" | "datacite" | "googlebooks" | "web" | "";
interface VerifyResult {
  exists: boolean;
  source: ExistenceSource;  // which check confirmed it (blank if none)
  doi?: string;
  crossrefUrl?: string;
  pmid?: string;
  pubmedUrl?: string;
  webUrl?: string;        // the cited URL that was checked (news/website references)
  webStatus?: string;     // "live-match" | "live-nomatch" | "dead" | "blocked" | "unreachable" | "no-url"
  matchedTitle?: string;  // the title as it appears in the database / on the web page (for compare)
  abstract?: string;      // captured when available (used in Phase 3 citation checking)
  retracted?: boolean;    // the cited work has been RETRACTED (PubMed pub-type / OpenAlex is_retracted)
  retractionNote?: string;// human-readable source of the retraction signal
}

const CR_UA = `RefCheck/1.0 (mailto:${CONTACT_EMAIL})`;

async function crossrefCheck(ref: GeminiRef): Promise<VerifyResult> {
  try {
    // 1) direct DOI lookup if we have one
    if (ref.doi) {
      const clean = ref.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
      const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, {
        headers: { "User-Agent": CR_UA },
      });
      if (r.ok) {
        const j = await r.json();
        const item = j?.message;
        if (item?.DOI) {
          return {
            exists: true, source: "crossref",
            doi: item.DOI,
            crossrefUrl: `https://doi.org/${item.DOI}`,
            matchedTitle: item.title?.[0],
            abstract: stripJats(item.abstract),
          };
        }
      }
    }
    // 2) bibliographic query — gather candidates from a title+authors query AND a title-only
    //    fallback (authors sometimes bury the real record in CrossRef ranking), then accept the
    //    best real match (polite pool via mailto in User-Agent).
    const queries: string[] = [];
    const tq = [ref.title, ref.authors].filter(Boolean).join(" ").trim();
    if (tq) queries.push(tq);
    const titleOnly = (ref.title ?? "").trim();
    if (titleOnly && titleOnly !== tq) queries.push(titleOnly);
    if (!queries.length) return { exists: false, source: "" };
    let bestTitle: string | undefined, bestScore = 0;
    const seen = new Set<string>();
    for (const q of queries) {
      const r = await fetch(
        `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=8&select=DOI,title,author,issued,abstract`,
        { headers: { "User-Agent": CR_UA } },
      );
      if (!r.ok) continue;
      const j = await r.json();
      const items = j?.message?.items ?? [];
      for (const item of items) {
        const t = item.title?.[0] ?? "";
        const key = String(item.DOI || t).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
      // an echoed DOI is authoritative
      if (ref.doi && item.DOI && ref.doi.toLowerCase().includes(String(item.DOI).toLowerCase())) {
        return {
          exists: true, source: "crossref", doi: item.DOI,
          crossrefUrl: `https://doi.org/${item.DOI}`, matchedTitle: t, abstract: stripJats(item.abstract),
        };
      }
      const fams = (item.author || []).map((a: { family?: string }) => a.family || "");
      const yr = (item.issued?.["date-parts"]?.[0]?.[0] || "").toString();
      const m = acceptMatch(ref, t, fams, yr);
      if (m.ok) {
        return {
          exists: true, source: "crossref", doi: item.DOI,
          crossrefUrl: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
          matchedTitle: t, abstract: stripJats(item.abstract),
        };
      }
        if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
      }
    }
    // Only surface a "closest database match" when it is genuinely close (a plausible metadata
    // mismatch). Don't show an unrelated work that merely shares a common word or leading phrase —
    // e.g. a long news headline that starts with a short book's title — that just looks alarming.
    return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
  } catch {
    return { exists: false, source: "" };
  }
}

// CrossRef abstracts arrive as JATS XML; strip tags to plain text.
function stripJats(s?: string): string | undefined {
  if (!s) return undefined;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

// ---- PubMed (NCBI E-utilities) existence check ----
function ncbi(path: string, params: Record<string, string>): string {
  const u = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}`);
  u.searchParams.set("tool", "refcheck");
  u.searchParams.set("email", CONTACT_EMAIL);
  if (PUBMED_API_KEY) u.searchParams.set("api_key", PUBMED_API_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function pubmedCheck(ref: GeminiRef): Promise<VerifyResult> {
  try {
    const title = (ref.title ?? "").trim();
    if (!title) return { exists: false, source: "" };
    const yr = String(ref.year || "").match(/\d{4}/)?.[0];
    const surn = surname(ref.authors);
    // progressively looser esearch queries until we get candidate PMIDs
    const attempts: string[] = [];
    if (yr) attempts.push(`${title} AND ${yr}[pdat]`);
    attempts.push(title);
    if (surn) attempts.push(`${title} ${surn}`);
    let ids: string[] = [];
    for (const term of attempts) {
      const sr = await fetch(ncbi("esearch.fcgi", { db: "pubmed", term, retmode: "json", retmax: "5" }));
      if (!sr.ok) continue;
      const sj = await sr.json();
      ids = sj?.esearchresult?.idlist ?? [];
      if (ids.length) break;
    }
    if (!ids.length) return { exists: false, source: "" };
    // esummary → compare candidate titles/authors/year to the reference
    const er = await fetch(ncbi("esummary.fcgi", { db: "pubmed", id: ids.join(","), retmode: "json" }));
    if (!er.ok) return { exists: false, source: "" };
    const ej = await er.json();
    const res = ej?.result ?? {};
    let bestTitle: string | undefined, bestScore = 0;
    for (const id of ids) {
      const cand = res[id];
      const candTitle = (cand?.title ?? "").replace(/\.$/, "");
      const fams = (cand?.authors || []).map((a: { name?: string }) => (a.name || "").split(/\s+/)[0]);
      const cy = (cand?.pubdate || "").match(/\d{4}/)?.[0] || "";
      const m = acceptMatch(ref, candTitle, fams, cy);
      if (m.ok) {
        // NCBI tags withdrawn articles with the "Retracted Publication" publication type.
        const pubtypes = (Array.isArray(cand?.pubtype) ? cand.pubtype : []).map((x: unknown) => String(x).toLowerCase());
        const retracted = pubtypes.includes("retracted publication");
        return {
          exists: true, source: "pubmed",
          pmid: id,
          pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          matchedTitle: candTitle,
          retracted: retracted || undefined,
          retractionNote: retracted ? "PubMed lists this article as a Retracted Publication." : undefined,
        };
      }
      if (m.score > bestScore) { bestScore = m.score; bestTitle = candTitle; }
    }
    // only a genuinely close near-miss is worth showing (see crossrefCheck note)
    return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
  } catch {
    return { exists: false, source: "" };
  }
}

// ---- OpenAlex existence check ----
// OpenAlex indexes ~250M scholarly works — far beyond CrossRef/PubMed — including books, book
// chapters, theses/dissertations, preprints, conference papers, datasets and reports. This is the
// single biggest reason a "real but not in CrossRef/PubMed" reference can still be confirmed.
function reconstructAbstract(inv?: Record<string, number[]>): string | undefined {
  if (!inv || typeof inv !== "object") return undefined;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = w;
  }
  const out = words.filter((w) => w != null).join(" ").replace(/\s+/g, " ").trim();
  return out || undefined;
}
async function openAlexCheck(ref: GeminiRef): Promise<VerifyResult> {
  try {
    const title = (ref.title ?? "").trim();
    if (!title) return { exists: false, source: "" };
    const u = new URL("https://api.openalex.org/works");
    u.searchParams.set("search", title);
    u.searchParams.set("per_page", "5");
    u.searchParams.set("mailto", CONTACT_EMAIL);
    const r = await fetch(u.toString(), { headers: { "User-Agent": CR_UA } });
    if (!r.ok) return { exists: false, source: "" };
    const j = await r.json();
    const items = j?.results ?? [];
    let bestTitle: string | undefined, bestScore = 0;
    for (const it of items) {
      const t = it?.title || it?.display_name || "";
      if (!t) continue;
      const fams = (it?.authorships || []).map((a: { author?: { display_name?: string }; raw_author_name?: string }) =>
        ((a?.author?.display_name || a?.raw_author_name || "").trim().split(/\s+/).pop() || ""));
      const yr = String(it?.publication_year || "");
      const m = acceptMatch(ref, t, fams, yr);
      if (m.ok) {
        const doi = String(it?.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
        const retracted = it?.is_retracted === true;
        return {
          exists: true, source: "openalex",
          doi: doi || undefined,
          crossrefUrl: it?.doi || (it?.id ? String(it.id) : undefined),
          matchedTitle: t,
          abstract: reconstructAbstract(it?.abstract_inverted_index),
          retracted: retracted || undefined,
          retractionNote: retracted ? "OpenAlex marks this work as retracted." : undefined,
        };
      }
      if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
    }
    return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
  } catch {
    return { exists: false, source: "" };
  }
}

// ---- DataCite existence check ----
// DataCite mints DOIs for datasets, theses/dissertations, preprints, software, and reports held in
// institutional/repository collections that CrossRef does not cover.
async function dataciteCheck(ref: GeminiRef): Promise<VerifyResult> {
  try {
    const title = (ref.title ?? "").trim();
    if (!title) return { exists: false, source: "" };
    const u = new URL("https://api.datacite.org/dois");
    u.searchParams.set("query", title);
    u.searchParams.set("page[size]", "5");
    const r = await fetch(u.toString(), { headers: { "User-Agent": CR_UA } });
    if (!r.ok) return { exists: false, source: "" };
    const j = await r.json();
    const items = j?.data ?? [];
    let bestTitle: string | undefined, bestScore = 0;
    for (const it of items) {
      const at = it?.attributes ?? {};
      const t = at?.titles?.[0]?.title || "";
      if (!t) continue;
      const fams = (at?.creators || []).map((c: { familyName?: string; name?: string }) =>
        (c?.familyName || String(c?.name || "").split(",")[0] || "").trim());
      const yr = String(at?.publicationYear || "");
      const m = acceptMatch(ref, t, fams, yr);
      if (m.ok) {
        const doi = String(at?.doi || it?.id || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
        return {
          exists: true, source: "datacite",
          doi: doi || undefined,
          crossrefUrl: doi ? `https://doi.org/${doi}` : undefined,
          matchedTitle: t,
        };
      }
      if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
    }
    return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
  } catch {
    return { exists: false, source: "" };
  }
}

// ---- Google Books existence check ----
// For books and book chapters, which are rarely in CrossRef/PubMed. Author-aware matching (via
// acceptMatch) guards against false positives on common book titles.
async function googleBooksCheck(ref: GeminiRef): Promise<VerifyResult> {
  try {
    const title = (ref.title ?? "").trim();
    if (!title) return { exists: false, source: "" };
    const u = new URL("https://www.googleapis.com/books/v1/volumes");
    u.searchParams.set("q", `intitle:${title}`);
    u.searchParams.set("maxResults", "5");
    u.searchParams.set("country", "US");
    const r = await fetch(u.toString(), { headers: { "User-Agent": CR_UA } });
    if (!r.ok) return { exists: false, source: "" };
    const j = await r.json();
    const items = j?.items ?? [];
    let bestTitle: string | undefined, bestScore = 0;
    for (const it of items) {
      const vi = it?.volumeInfo ?? {};
      const t = [vi?.title, vi?.subtitle].filter(Boolean).join(": ");
      if (!t) continue;
      const fams = (vi?.authors || []).map((a: string) => (a.trim().split(/\s+/).pop() || ""));
      const yr = String(vi?.publishedDate || "").match(/\d{4}/)?.[0] || "";
      const m = acceptMatch(ref, t, fams, yr);
      if (m.ok) {
        return {
          exists: true, source: "googlebooks",
          matchedTitle: t,
          webUrl: vi?.infoLink || vi?.canonicalVolumeLink || undefined,
          abstract: typeof vi?.description === "string" ? vi.description : undefined,
        };
      }
      if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
    }
    return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
  } catch {
    return { exists: false, source: "" };
  }
}

// ---- Web/news existence check ----
// News articles, websites, and many reports are NOT in CrossRef or PubMed. When a reference carries
// a URL we verify it directly: fetch the page, confirm it resolves, and check that its title matches
// the cited article (so a paywall/homepage redirect or a dead link doesn't count as confirmation).
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHALLENGE_TITLES = [
  "just a moment", "attention required", "client challenge", "access denied", "are you a robot",
  "captcha", "access to this page has been denied", "please enable cookies", "you have been blocked",
];

// pull a URL out of the parsed field or, failing that, the raw reference string
function extractUrl(ref: GeminiRef): string {
  let u = (ref.url ?? "").trim();
  if (!u) { const m = (ref.raw ?? "").match(/https?:\/\/[^\s)\]}"'>]+/i); if (m) u = m[0]; }
  if (!u) { const m = (ref.raw ?? "").match(/\bwww\.[^\s)\]}"'>]+/i); if (m) u = "https://" + m[0]; }
  return u.replace(/[.,;>)\]]+$/, "").trim();
}
// block non-public / non-http targets (basic SSRF guard)
function isPublicHttpUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1|fe80:|fc00:|fd00:)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}
function stripSiteSuffix(title: string): string {
  return (title || "").replace(/\s*[|–—-]\s*[^|–—-]{1,40}$/, "").trim() || (title || "").trim();
}
function extractPageTitle(html: string): string {
  const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']{1,200})/i) ||
    html.match(/content=["']([^"']{1,200})["'][^>]*property=["']og:title["']/i);
  const tt = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return (og?.[1] || tt?.[1] || "")
    .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}
// does the cited title match the page's title? (order-independent token overlap)
function webTitleMatch(refTitle: string, pageTitle: string): boolean {
  const A = new Set(titleTokens(refTitle)), B = new Set(titleTokens(stripSiteSuffix(pageTitle)));
  if (!A.size || !B.size) return false;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const contRef = inter / A.size; // fraction of the citation's words present on the page
  return (dice >= 0.6 && inter >= 3) || (contRef >= 0.8 && inter >= 3) || (A.size <= 3 && contRef >= 0.9 && inter >= 2);
}
async function webCheck(ref: GeminiRef): Promise<VerifyResult> {
  const url = extractUrl(ref);
  if (!url || !isPublicHttpUrl(url)) return { exists: false, source: "", webStatus: "no-url" };
  let status = 0, html = "";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
    });
    status = r.status;
    if (r.ok) html = (await r.text()).slice(0, 250_000);
  } catch { return { exists: false, source: "", webUrl: url, webStatus: "unreachable" }; }

  const pageTitle = html ? extractPageTitle(html) : "";
  const challenge = CHALLENGE_TITLES.some((c) => pageTitle.toLowerCase().includes(c));
  if (status >= 200 && status < 400 && pageTitle && !challenge) {
    if (webTitleMatch(ref.title ?? "", pageTitle)) {
      return { exists: true, source: "web", webUrl: url, webStatus: "live-match", matchedTitle: pageTitle };
    }
    return { exists: false, source: "", webUrl: url, webStatus: "live-nomatch", matchedTitle: pageTitle };
  }
  if (challenge || status === 401 || status === 403) return { exists: false, source: "", webUrl: url, webStatus: "blocked" };
  if (status >= 400 && status < 500) return { exists: false, source: "", webUrl: url, webStatus: "dead" };
  return { exists: false, source: "", webUrl: url, webStatus: "unreachable" };
}

// Cascade of existence checks, from most authoritative/most likely to least. We DON'T stop at "not
// in CrossRef/PubMed" — a miss there is expected for books, theses, preprints, reports and
// non-indexed journals, so we keep looking (OpenAlex -> DataCite -> Google Books) and, for anything
// with a URL, verify the live page. A reference is only "not found" after ALL of these come up empty.
// Look up retraction status by DOI on OpenAlex (covers CrossRef-confirmed hits, which don't carry a
// retraction flag themselves). is_retracted is OpenAlex's cross-source withdrawal signal.
async function openAlexRetractedByDoi(doi: string): Promise<boolean> {
  try {
    const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    if (!clean) return false;
    const u = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
    const r = await fetch(u, { headers: { "User-Agent": CR_UA } });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.is_retracted === true;
  } catch {
    return false;
  }
}

// If a confirmed reference has a DOI but no retraction flag yet, probe OpenAlex once to catch
// retractions that CrossRef (the first, fast path) doesn't report.
async function augmentRetraction(hit: VerifyResult): Promise<VerifyResult> {
  if (hit.retracted) return hit;
  // PubMed (pub-type) and OpenAlex (is_retracted) already report retraction directly — only the other
  // sources (CrossRef/DataCite/Google Books) need the extra DOI probe.
  if (hit.source === "pubmed" || hit.source === "openalex") return hit;
  if (hit.doi && await openAlexRetractedByDoi(hit.doi)) {
    return { ...hit, retracted: true, retractionNote: "OpenAlex marks this DOI as retracted." };
  }
  return hit;
}

async function verifyExistence(ref: GeminiRef): Promise<VerifyResult> {
  let hit: VerifyResult | null = null;
  const cr = await crossrefCheck(ref);
  if (cr.exists) hit = cr;
  let pm: VerifyResult | undefined, oa: VerifyResult | undefined,
    dc: VerifyResult | undefined, gb: VerifyResult | undefined, web: VerifyResult | undefined;
  if (!hit) { pm = await pubmedCheck(ref); if (pm.exists) hit = { ...pm, doi: pm.doi ?? cr.doi, crossrefUrl: pm.crossrefUrl ?? cr.crossrefUrl }; }
  // broaden the search well beyond the two big medical/journal indexes
  if (!hit) { oa = await openAlexCheck(ref); if (oa.exists) hit = { ...oa, doi: oa.doi ?? cr.doi, crossrefUrl: oa.crossrefUrl ?? cr.crossrefUrl }; }
  if (!hit) { dc = await dataciteCheck(ref); if (dc.exists) hit = { ...dc, doi: dc.doi ?? cr.doi, crossrefUrl: dc.crossrefUrl ?? cr.crossrefUrl }; }
  if (!hit) { gb = await googleBooksCheck(ref); if (gb.exists) hit = { ...gb, doi: cr.doi, crossrefUrl: cr.crossrefUrl }; }
  // still nothing — if it has a URL, verify that web/news source directly
  if (!hit) { web = await webCheck(ref); if (web.exists) hit = { ...web, doi: cr.doi, crossrefUrl: cr.crossrefUrl }; }

  if (hit) return await augmentRetraction(hit);

  // nothing confirmed anywhere — carry the best near-miss title + any web link status for the message
  return {
    exists: false, source: "",
    doi: cr.doi, crossrefUrl: cr.crossrefUrl,
    matchedTitle: cr.matchedTitle ?? pm?.matchedTitle ?? oa?.matchedTitle ?? dc?.matchedTitle ?? gb?.matchedTitle ?? web?.matchedTitle,
    webUrl: web?.webUrl, webStatus: web?.webStatus,
  };
}

// run existence checks with limited concurrency
async function verifyAll(refs: GeminiRef[]): Promise<VerifyResult[]> {
  const out: VerifyResult[] = new Array(refs.length);
  let idx = 0;
  async function worker() {
    while (idx < refs.length) {
      const i = idx++;
      out[i] = await verifyExistence(refs[i]);
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));
  return out;
}

// ---- reconcile Gemini verdict + CrossRef/PubMed existence ----
// Design principle: the databases give POSITIVE confirmation. A database *miss* is only weak
// evidence — many legitimate works (books, theses, conference papers, preprints, and articles in
// non-indexed journals) are simply not in CrossRef or PubMed. So a miss may soften confidence, but
// it must NEVER by itself turn a reference into "flagged". Fabrication flags come from the AI's
// judgment; a database miss can reinforce an existing AI flag but can never create one. This is
// what prevents a real-but-unindexed reference from being wrongly flagged as fake.
const SOURCE_LABEL: Record<ExistenceSource, string> = {
  crossref: "CrossRef", pubmed: "PubMed", openalex: "OpenAlex",
  datacite: "DataCite", googlebooks: "Google Books", web: "the web", "": "a database",
};
function reconcile(ref: GeminiRef, cr: VerifyResult) {
  let verdict = ref.verdict ?? "review";
  let reason = ref.reason ?? "";
  const where = SOURCE_LABEL[cr.source] || "a database";

  if (cr.exists) {
    if (cr.source === "web") {
      // the cited URL resolves AND its page title matches the citation -> the web source is real
      if (verdict === "flagged") {
        verdict = "review";
        reason = `The cited link is live and its page title matches this reference, so it appears to be a real web source — but double-check the details. ` + reason;
      } else {
        verdict = "verified";
        reason = `Confirmed live at the cited link (the page's title matches this reference). ` + reason;
      }
    } else if (verdict === "flagged") {
      // DB found it, so it is very likely real — de-escalate from "fabricated" to "check details"
      verdict = "review";
      reason = `Found in ${where}, so it appears to be a real publication, though some details may differ — worth a look. ` + reason;
    } else if (verdict !== "verified" && (ref.confidence ?? 1) >= 0.6) {
      verdict = "verified";
    }
  } else {
    // not confirmed in CrossRef, PubMed, or at a live URL — weak evidence only.
    // If the reference carried a URL, explain what the web check found.
    const webNote =
      cr.webStatus === "dead"
        ? `The cited web link appears to be broken (the page was not found) — check that the URL is correct. `
        : cr.webStatus === "live-nomatch"
        ? `The cited link opens, but its page title doesn't clearly match this reference — verify you have the correct link. `
        : cr.webStatus === "blocked"
        ? `The cited web link couldn't be auto-checked because the site blocks automated access — please open it manually to confirm. `
        : cr.webStatus === "unreachable"
        ? `The cited web link couldn't be reached to verify it — please check it manually. `
        : "";

    if (verdict === "verified") {
      // don't call a confident, well-formed reference "fabricated" just because it isn't indexed
      verdict = "review";
      reason = webNote +
        `Not found in CrossRef, PubMed, OpenAlex, DataCite, or Google Books — this can still happen for some books, theses, conference papers, preprints, non-indexed journals, and news/website sources, so confirm it manually rather than assuming it is fake. ` +
        reason;
    } else if (verdict === "flagged") {
      // Reserve the hard "flagged / likely fabricated" label for HIGH-confidence AI judgments. Many
      // legitimate references (news, books, reports, preprints, non-indexed journals) are not in these
      // databases, so a merely uncertain AI flag on an unconfirmed reference is softened to "review".
      if ((ref.confidence ?? 0) >= 0.85) {
        reason = webNote +
          `The AI judged this likely fabricated (high confidence) and it could not be confirmed in CrossRef, PubMed, OpenAlex, DataCite, Google Books, or at a working link. ` +
          reason;
        // stays flagged
      } else {
        verdict = "review";
        reason = webNote + `Could not automatically verify this reference — please confirm it manually. ` + reason;
      }
    } else if (webNote) {
      // "review" stays "review" but gains the web-link note
      reason = webNote + reason;
    }
    // "review" stays "review": surfaced for a human, but never auto-escalated to "flagged" on a miss
  }
  // Retraction is orthogonal to fabrication: the work is REAL but has been withdrawn and must not be
  // cited as valid evidence. Surface it loudly and never let a retracted paper sit in clean "verified".
  if (cr.retracted) {
    reason = `RETRACTED: ${cr.retractionNote || "This publication has been retracted and should not be cited as valid evidence."} ` + reason;
    if (verdict === "verified") verdict = "review";
  }
  return { verdict, reason: reason.trim(), retracted: !!cr.retracted };
}

// ---- handler ----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!GEMINI_API_KEY) {
    return json({ error: "Server is missing GEMINI_API_KEY. Set it with `supabase secrets set`." }, 500);
  }

  let body: {
    action?: string;
    filename?: string; referencesText?: string;
    claim?: string; paperText?: string; paperTitle?: string; basis?: string;
    ref?: MatchRef;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // ---- Phase 3: citation-checking action (one claim vs. one cited paper) ----
  if (body.action === "cite") {
    const claim = (body.claim ?? "").toString().trim();
    const paperText = (body.paperText ?? "").toString();
    if (!claim) return json({ error: "No claim was provided." }, 400);
    if (!paperText.trim()) return json({ error: "No cited-paper text was provided." }, 400);
    const basis = body.basis === "abstract" ? "abstract" : "full text";
    try {
      const out = await assessCitation(claim, paperText, (body.paperTitle ?? "").toString(), basis);
      return json({ ...out, basis });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Citation check failed." }, 500);
    }
  }

  // ---- Phase 3b: source-PDF identity verification (is this uploaded PDF the cited work?) ----
  if (body.action === "match") {
    const paperText = (body.paperText ?? "").toString();
    const ref = (body.ref ?? {}) as MatchRef;
    if (!paperText.trim()) return json({ error: "No source-PDF text was provided." }, 400);
    if (!(ref.title || ref.raw)) return json({ error: "No reference was provided to match against." }, 400);
    try {
      const out = await assessMatch(ref, paperText);
      return json(out);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Source match failed." }, 500);
    }
  }

  const filename = (body.filename ?? "manuscript").toString().slice(0, 200);
  let text = (body.referencesText ?? "").toString();
  if (!text.trim()) return json({ error: "No references text was provided." }, 400);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  try {
    // 1) Gemini extract + judge (chunked so the WHOLE bibliography is read, not just the start)
    const gemini = await analyzeReferences(text);
    const allRefs = gemini.references;
    if (!allRefs.length) {
      return json({ error: "No references could be extracted from that document." }, 422);
    }
    // Existence-check up to MAX_REFS. Any beyond the cap are NOT dropped — they are returned as
    // "review" with a clear note, so no reference is ever silently hidden from the user.
    const refs = allRefs.slice(0, MAX_REFS);
    const overflow = allRefs.slice(MAX_REFS);

    // 2) existence checks — CrossRef, then PubMed fallback
    const verify = await verifyAll(refs);

    // 3) reconcile
    const references = refs.map((ref, i) => {
      const cr = verify[i] ?? { exists: false, source: "" as const };
      const { verdict, reason, retracted } = reconcile(ref, cr);
      return {
        id: ref.id,
        raw: ref.raw,
        authors: ref.authors ?? "",
        title: ref.title ?? "",
        year: ref.year ?? "",
        journal: ref.journal ?? "",
        doi: cr.doi ?? ref.doi ?? "",
        marker: ref.marker ?? "",
        confidence: typeof ref.confidence === "number" ? ref.confidence : null,
        exists: cr.exists,
        source: cr.source ?? "",
        crossrefUrl: cr.crossrefUrl ?? "",
        pmid: cr.pmid ?? "",
        pubmedUrl: cr.pubmedUrl ?? "",
        url: ref.url ?? extractUrl(ref) ?? "",
        webUrl: cr.webUrl ?? "",
        webStatus: cr.webStatus ?? "",
        matchedTitle: cr.matchedTitle ?? "",
        abstract: cr.abstract ?? "",
        retracted: !!retracted,
        verdict,
        reason,
      };
    });

    // keep (never drop) references beyond the existence-check cap
    for (const ref of overflow) {
      references.push({
        id: ref.id,
        raw: ref.raw,
        authors: ref.authors ?? "",
        title: ref.title ?? "",
        year: ref.year ?? "",
        journal: ref.journal ?? "",
        doi: ref.doi ?? "",
        marker: ref.marker ?? "",
        confidence: typeof ref.confidence === "number" ? ref.confidence : null,
        exists: false,
        source: "" as const,
        crossrefUrl: "",
        pmid: "",
        pubmedUrl: "",
        url: ref.url ?? extractUrl(ref) ?? "",
        webUrl: "",
        webStatus: "",
        matchedTitle: "",
        abstract: "",
        retracted: false,
        verdict: "review" as const,
        reason:
          `This document has more than ${MAX_REFS} references; this one was extracted but not auto-verified ` +
          `against CrossRef/PubMed in this run — please check it manually. ` + (ref.reason ?? ""),
      });
    }

    const counts = {
      verified: references.filter((r) => r.verdict === "verified").length,
      review: references.filter((r) => r.verdict === "review").length,
      flagged: references.filter((r) => r.verdict === "flagged").length,
    };
    const total = references.length;
    const integrityScore = Math.round((100 * (counts.verified + 0.5 * counts.review)) / total);

    return json({ filename, total, counts, integrityScore, citationStyle: gemini.citationStyle, references });
  } catch (err) {
    return json({ error: (err instanceof Error ? err.message : "Analysis failed.") }, 500);
  }
});

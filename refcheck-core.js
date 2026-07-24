// ============================================================
// REF/CHECK AI — client-side core (no server, no login, no cloud)
// This is the FULL port of the old Supabase `verify` Edge Function into the browser.
//   • Reference existence checks (CrossRef → PubMed → OpenAlex → DataCite → Google Books → Wayback)
//     run directly from the browser — these public APIs allow CORS, so NO key is needed.
//   • Gemini calls (extract references, check a claim vs. its source, match a source PDF to a
//     reference) go straight from the browser to Google with the user's OWN key.
// Nothing is uploaded to any server of ours. The manuscript never leaves this machine except for
// the direct API calls above.
//
// Public surface (window.RefCheckCore):
//   getSettings() / saveSettings(patch)         — { geminiKey, email, model, dailyLimit }
//   usageToday()                                — { count, date }
//   detectModels()                             — validate key + list usable models
//   run(body)  -> { data, error }              — mirrors the old sb.functions.invoke("verify", …)
//                                                 body.action: undefined=verify | "cite" | "match"
// ============================================================
(function () {
  "use strict";

  // Determinism: temperature 0 + a fixed seed on every Gemini call so the SAME input yields the SAME
  // output on every run (no drifting reference counts / verdicts).
  const GEN_SEED = 7;
  const MAX_CHARS = 200000;      // bibliography cap (extraction is chunked below)
  const MAX_REFS = 150;          // existence-check up to this many; overflow kept, not dropped
  const CHUNK_CHARS = 14000;     // per-Gemini extraction slice
  const EXTRACT_CONCURRENCY = 3; // parallel Gemini extraction calls
  const VERIFY_CONCURRENCY = 6;  // parallel existence checks
  const MAX_CITE_CHARS = 60000;
  const MAX_MATCH_CHARS = 200000;
  // The ONLY model this app uses. Locked to gemini-3.5-flash-lite (most generous free per-minute limit).
  const DEFAULT_MODEL = "gemini-3.5-flash-lite";
  const ALLOWED_MODELS = [DEFAULT_MODEL];

  // ---------- settings (localStorage; this machine only) ----------
  const SETTINGS_KEY = "refcheck-settings";
  const USAGE_KEY = "refcheck-usage";
  function getSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch (_) {}
    return {
      geminiKey: s.geminiKey || "",
      email: s.email || "",
      // Locked to the single allowed model — ignore any older stored value (e.g. gemini-2.5-*).
      model: ALLOWED_MODELS.includes(s.model) ? s.model : DEFAULT_MODEL,
      dailyLimit: Number.isFinite(s.dailyLimit) ? s.dailyLimit : 200,
    };
  }
  function saveSettings(patch) {
    const merged = { ...getSettings(), ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged)); } catch (_) {}
    return merged;
  }

  // ---------- daily check limit (safety stop against the free quota) ----------
  function today() { return new Date().toISOString().slice(0, 10); }
  function usageToday() {
    let u = {};
    try { u = JSON.parse(localStorage.getItem(USAGE_KEY) || "{}") || {}; } catch (_) {}
    if (u.date !== today()) return { date: today(), count: 0 };
    return { date: u.date, count: u.count || 0 };
  }
  function bumpUsage() {
    const s = getSettings();
    const u = usageToday();
    if (s.dailyLimit > 0 && u.count >= s.dailyLimit) {
      throw new Error(`Daily check limit reached (${s.dailyLimit}). Raise it in Settings, or continue tomorrow.`);
    }
    const next = { date: today(), count: u.count + 1 };
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(next)); } catch (_) {}
  }

  // ---------- Gemini (rate-limited + auto-retry on 429) ----------
  // Free-tier Gemini allows only ~10 requests/minute, so we (a) serialize all calls with a minimum gap
  // to avoid instantaneous bursts, and (b) on a 429 wait the delay Google suggests (or exponential
  // backoff) and retry — so a burst self-heals instead of failing the claim.
  const GEMINI_MIN_GAP_MS = 1300;
  const GEMINI_MAX_RETRIES = 5;
  const GEMINI_MAX_BACKOFF_MS = 60000;
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // The public existence APIs (CrossRef especially) throttle bursts — and we fire several checks at once.
  // A single 429/503 or a dropped connection used to silently sink a REAL reference to "not found",
  // because the whole cascade falls through when its first, best index hiccups. Retry transient failures
  // (network error, 429, 5xx) a few times with backoff so a real, findable work isn't lost to a blip.
  async function fetchRetry(url, opts, tries) {
    tries = tries || 3;
    for (let i = 0; ; i++) {
      let r;
      try {
        r = await fetch(url, opts);
      } catch (e) {
        if (i >= tries - 1) throw e;
        await sleep(500 * (i + 1) + Math.random() * 250);
        continue;
      }
      const transient = r.status === 429 || (r.status >= 500 && r.status <= 599);
      if (r.ok || !transient || i >= tries - 1) return r;
      await sleep(500 * (i + 1) + Math.random() * 250);
    }
  }

  let _gemLast = 0, _gemChain = Promise.resolve();
  // Serialize every Gemini call through one chain with a min gap between them. While a call is sleeping
  // for a 429 retry, the whole chain waits behind it — exactly the back-pressure we want at the RPM ceiling.
  function scheduleGemini(task) {
    const run = _gemChain.then(async () => {
      const wait = GEMINI_MIN_GAP_MS - (Date.now() - _gemLast);
      if (wait > 0) await sleep(wait);
      try { return await task(); } finally { _gemLast = Date.now(); }
    });
    _gemChain = run.then(() => {}, () => {}); // keep the chain alive regardless of success/failure
    return run;
  }
  function parseRetryDelayMs(detail, attempt) {
    // Google returns error.details[] with @type RetryInfo + retryDelay like "27s"
    try {
      const j = JSON.parse(detail);
      for (const d of (j?.error?.details || [])) {
        const m = typeof d?.retryDelay === "string" ? d.retryDelay.match(/([\d.]+)s/) : null;
        if (m) return Math.min(GEMINI_MAX_BACKOFF_MS, Math.ceil(parseFloat(m[1]) * 1000) + 600);
      }
    } catch (_) {}
    return Math.min(GEMINI_MAX_BACKOFF_MS, Math.round(4000 * Math.pow(2, attempt) + Math.random() * 1000));
  }
  async function geminiGenerate(prompt, schema) {
    const s = getSettings();
    if (!s.geminiKey) throw new Error("No Gemini API key set — add your key in Settings to use AI checks.");
    bumpUsage(); // counts ONE logical check; the retries below never double-count
    return scheduleGemini(() => geminiAttempt(prompt, schema, s, 0));
  }
  async function geminiAttempt(prompt, schema, s, attempt) {
    const model = s.model || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(s.geminiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, seed: GEN_SEED, responseMimeType: "application/json", responseSchema: schema },
        }),
      });
    } catch (e) {
      throw new Error("Couldn't reach Google's Gemini API from the browser — check your connection and that the key is valid.");
    }
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      try { return JSON.parse(text); } catch { throw new Error("Could not parse the model's response."); }
    }
    let detail = "";
    try { detail = await res.text(); } catch (_) {}
    if (res.status === 429 && attempt < GEMINI_MAX_RETRIES) {
      const waitMs = parseRetryDelayMs(detail, attempt); // chain is serialized, so this backs off everything
      // let the UI show a "paused, resuming in Ns" countdown instead of looking stuck
      try { window.dispatchEvent(new CustomEvent("refcheck-throttle", { detail: { waitMs, until: Date.now() + waitMs } })); } catch (_) {}
      await sleep(waitMs);
      try { window.dispatchEvent(new CustomEvent("refcheck-throttle-end", {})); } catch (_) {}
      return geminiAttempt(prompt, schema, s, attempt + 1);
    }
    if (res.status === 400 && /API key not valid/i.test(detail)) throw new Error("Gemini rejected the API key — double-check it in Settings.");
    if (res.status === 429) throw new Error("Gemini's free-tier limit was hit repeatedly (429). The free tier allows only a limited number of requests per minute — check fewer sources at once, or wait a minute and try again.");
    throw new Error(`Gemini request failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  // List models that support generateContent (used by the "Detect available models" button).
  async function detectModels() {
    const s = getSettings();
    if (!s.geminiKey) throw new Error("Enter your key first.");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(s.geminiKey)}`);
    if (!r.ok) {
      if (r.status === 400 || r.status === 403) throw new Error("That key was rejected by Google. Check it and try again.");
      throw new Error(`Couldn't list models (${r.status}).`);
    }
    const j = await r.json();
    const models = (j?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => (m.name || "").replace(/^models\//, ""))
      .filter((n) => /^gemini/i.test(n));
    return models;
  }

  // ============================================================
  // Gemini call 1 — extract + judge references
  // ============================================================
  async function extractChunk(referencesText) {
    const dt = new Date().toISOString().slice(0, 10);
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
    - "verified": looks like a real, well-formed, plausible publication
    - "review": real-looking but with inconsistencies, missing info, or details that don't add up
    - "flagged": likely fabricated/hallucinated (implausible authors+title+venue combo, fake-looking DOI, nonsensical)
- confidence: 0..1 for your verdict
- reason: a specific, evidence-based explanation of the verdict.
    - For "flagged" or "review": QUOTE the exact text from THIS reference that concerns you — copy the
      problematic fragment inside double quotes — and explain precisely what is wrong or unusual. Be
      concrete and point at the actual words. 2 to 4 sentences.
    - For "verified": one short sentence is enough.

IMPORTANT judging rules (this tool is used by researchers; a wrong "flagged" is very costly):
- Today's date is ${dt}. References dated up to and including the current year are valid — NEVER flag a
  reference merely because its year looks recent or "in the future" relative to what you remember.
- References are not only journal articles. Books, book chapters, conference papers, preprints
  (arXiv/bioRxiv/SSRN), theses/dissertations, datasets, software, standards, government or organizational
  reports, and news/media articles are ALL legitimate references. Do NOT flag a reference just because it
  is not a journal article, has no DOI, is a news/web source, or is unfamiliar to you.
- Use "flagged" ONLY when the reference is internally contradictory or shows concrete signs of being
  fabricated (e.g. an author+title+venue combination that could not plausibly coexist, or an obviously
  fake identifier). If you are not confident it is fabricated, use "review", never "flagged".
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
              raw: { type: "STRING" }, authors: { type: "STRING" }, title: { type: "STRING" },
              year: { type: "STRING" }, journal: { type: "STRING" }, doi: { type: "STRING" },
              url: { type: "STRING" }, marker: { type: "STRING" },
              verdict: { type: "STRING", enum: ["verified", "review", "flagged"] },
              confidence: { type: "NUMBER" }, reason: { type: "STRING" },
            },
            required: ["raw", "verdict", "reason"],
          },
        },
      },
      required: ["citationStyle", "references"],
    };
    const parsed = await geminiGenerate(prompt, schema);
    const refs = (Array.isArray(parsed?.references) ? parsed.references : []).map((r, i) => ({ ...r, id: i + 1 }));
    return { citationStyle: parsed?.citationStyle ?? "unknown", references: refs };
  }

  function segmentReferences(text) {
    const lines = text.split(/\r?\n/);
    const numbered = /^\s*(\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+\S/;
    const authorYear = /^\s*[A-Z][A-Za-z'’-]+,\s+[A-Z]\.?/;
    const entries = [];
    let cur = "", starts = 0;
    for (const ln of lines) {
      const isStart = numbered.test(ln) || authorYear.test(ln);
      if (isStart && cur.trim()) { entries.push(cur.trim()); cur = ln; starts++; }
      else cur = cur ? cur + "\n" + ln : ln;
    }
    if (cur.trim()) entries.push(cur.trim());
    return starts >= 3 ? entries : [text];
  }
  function packChunks(text) {
    if (text.length <= CHUNK_CHARS) return [text];
    const entries = segmentReferences(text);
    if (entries.length > 1) {
      const chunks = [];
      let buf = "";
      for (const e of entries) {
        if (buf && buf.length + e.length + 1 > CHUNK_CHARS) { chunks.push(buf); buf = e; }
        else buf = buf ? buf + "\n" + e : e;
      }
      if (buf) chunks.push(buf);
      return chunks;
    }
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + CHUNK_CHARS, text.length);
      if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > i + 1000) end = nl; }
      chunks.push(text.slice(i, end));
      i = end;
    }
    return chunks;
  }
  async function analyzeReferences(text) {
    const chunks = packChunks(text);
    if (chunks.length === 1) return await extractChunk(chunks[0]);
    const results = new Array(chunks.length).fill(null);
    let idx = 0;
    async function worker() {
      while (idx < chunks.length) {
        const i = idx++;
        try { results[i] = await extractChunk(chunks[i]); }
        catch { results[i] = { citationStyle: "unknown", references: [] }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, chunks.length) }, worker));
    const seen = new Set();
    const merged = [];
    const styleVotes = {};
    for (const r of results) {
      if (!r) continue;
      styleVotes[r.citationStyle] = (styleVotes[r.citationStyle] ?? 0) + 1;
      for (const ref of r.references) {
        const key = normalizeTitle(ref.raw || ref.title || "").slice(0, 140);
        if (!key || seen.has(key)) continue;
        seen.add(key); merged.push(ref);
      }
    }
    const citationStyle = ["numbered", "author-year", "unknown"]
      .sort((a, b) => (styleVotes[b] ?? 0) - (styleVotes[a] ?? 0))[0];
    return { citationStyle, references: merged.map((r, i) => ({ ...r, id: i + 1 })) };
  }

  // ============================================================
  // Gemini call 2 — claim vs. cited paper (with Broad/Critical strictness)
  // ============================================================
  async function assessCitation(claim, paperText, paperTitle, basis, strictness) {
    const source = (paperText || "").slice(0, MAX_CITE_CHARS);
    const strict = strictness === "critical"
      ? `STRICTNESS: CRITICAL. Hold the manuscript to its exact wording for final pre-submission rigor. Flag ANY overstatement, oversimplification, dropped caveat, or number that does not match precisely as "partial", even when the gist is defensible. Use "supported" only when the source fully and precisely supports the claim as written.`
      : `STRICTNESS: BROAD. Judge whether the author actually used this source for this claim. Accept defensible, good-faith readings: reasonable paraphrase, rounding, and summary are fine, and mild wording differences are NOT a problem. Use "supported" whenever the source substantively backs the claim, even if the manuscript's wording is somewhat stronger. Reserve "partial" for a real, material overstatement or a genuinely mismatched number, and "not_supported" for claims the source does not address or directly contradicts. Do not nitpick wording.`;
    const basisNote = basis === "abstract"
      ? `\nIMPORTANT — YOU ONLY HAVE THE ABSTRACT, not the full text. An abstract can CONFIRM a claim but usually cannot DISPROVE one (the detail may simply live in the body). If the abstract does not contain the specific detail this claim needs, do NOT return "not_supported" — return "unclear" and say in the explanation that the full text (or the uploaded source PDF) is needed to verify this claim. Only use "not_supported" if the abstract itself directly CONTRADICTS the claim.`
      : "";
    const prompt = `You are a meticulous scientific citation checker. Below is a claim made in a manuscript
and the text of the paper that was cited to support it (this is the paper's ${basis}).

CLAIM FROM MANUSCRIPT: """${claim}"""
CITED PAPER${paperTitle ? ` ("${paperTitle}")` : ""} ${String(basis).toUpperCase()}: """${source}"""

Your job: find the ACTUAL passage in the cited paper that bears on this claim, quote a substantial
chunk of it word for word, and judge whether the paper really supports what the manuscript says.

${strict}${basisNote}

Steps:
1. Break the claim into its concrete checkable assertions — sample/enrollment sizes, population or
   setting, the intervention and its parameters (doses, durations, timing), comparisons, the outcome
   plus its DIRECTION and SIGNIFICANCE, and any stated nuance or subgroup finding.
2. Search the paper for the passage that actually addresses them, and copy it VERBATIM into "sourceQuote".
   Quote a MEANINGFUL CHUNK — a full paragraph, or several consecutive sentences (roughly 2 to 6 sentences,
   about 40 to 120 words) — not a lone fragment. It must be one contiguous block of the paper's real text
   that a reader could Ctrl+F and find, containing the actual numbers/findings/wording the claim stands or
   falls on. Copy the exact words; do NOT paraphrase, stitch together distant sentences, shorten with "...",
   or invent text. If the paper genuinely says nothing relevant, quote the closest related paragraph (still
   verbatim), or "" if there is truly none.

Choose exactly one assessment:
- "supported": the paper backs up the claim's substance
- "partial": the paper supports part of it, OR the manuscript overstates / mismatches a number / omits a key caveat
- "not_supported": the paper does not support the claim, contradicts it, or never addresses it
- "unclear": the provided text is insufficient to tell

Then write "explanation" (about 3 to 5 sentences) that puts the manuscript's claim SIDE BY SIDE with the
quoted passage — as if pointing at both on screen:
- If supported: say plainly the claim lines up with the source, pointing to the exact matching figures/wording.
- If partial: say what the manuscript got right AND exactly what it overstated/mismatched/left out, naming the
  source's real numbers/wording.
- If not_supported: say clearly the source does not support the claim — exaggerated, distorted, or simply
  absent — and spell out what the source ACTUALLY says instead, pointing right at the quoted passage.
- Always use the paper's real numbers, values, and terms. Be specific and concrete. Do not invent anything.`;

    const schema = {
      type: "OBJECT",
      properties: {
        assessment: { type: "STRING", enum: ["supported", "partial", "not_supported", "unclear"] },
        sourceQuote: { type: "STRING" },
        explanation: { type: "STRING" },
      },
      required: ["assessment", "explanation"],
    };
    const parsed = await geminiGenerate(prompt, schema);
    const assessment = ["supported", "partial", "not_supported", "unclear"].includes(parsed?.assessment)
      ? parsed.assessment : "unclear";
    return {
      assessment,
      explanation: (parsed?.explanation ?? "").trim(),
      sourceQuote: (parsed?.sourceQuote ?? "").trim(),
    };
  }

  // ============================================================
  // Gemini call 3 — is this uploaded PDF the cited work?
  // ============================================================
  async function assessMatch(ref, paperText) {
    const source = (paperText || "").slice(0, MAX_MATCH_CHARS);
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
  year corroborate). Minor formatting/punctuation differences are fine, as is a mismatched DOI when the
  title, authors and year all agree.
- "partial": probably the same work but with a real substantive discrepancy in TITLE, AUTHORS or YEAR.
  Explain the exact discrepancy. Do not use "partial" for a DOI-only difference.
- "mismatch": the PDF is a DIFFERENT work than the reference, or there is not enough evidence it is the same.

Then write a SPECIFIC explanation (3 to 6 sentences) that SHOWS YOUR WORK by quoting the PDF directly:
- Quote the PDF's real title exactly as it appears, inside double quotes.
- Quote the PDF's author line / affiliation and the year or DOI as they appear in the PDF.
- State precisely how each lines up with, or differs from, the reference.
- If it is a mismatch, name what the PDF is actually about instead. Never invent text not present above.

Also return:
- foundTitle: the PDF's real title, copied verbatim (empty only if truly none is present)
- foundAuthors: the PDF's real author list, from the PDF
- foundYear: the PDF's real year, from the PDF
- evidence: an array of 2 to 4 SHORT verbatim quotes copied from the PDF that justify the verdict. Copy exactly.`;

    const schema = {
      type: "OBJECT",
      properties: {
        verdict: { type: "STRING", enum: ["confirmed", "partial", "mismatch"] },
        explanation: { type: "STRING" },
        foundTitle: { type: "STRING" }, foundAuthors: { type: "STRING" }, foundYear: { type: "STRING" },
        evidence: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["verdict", "explanation"],
    };
    const parsed = await geminiGenerate(prompt, schema);
    const verdict = ["confirmed", "partial", "mismatch"].includes(parsed?.verdict) ? parsed.verdict : "mismatch";
    const evidence = Array.isArray(parsed?.evidence)
      ? parsed.evidence.filter((x) => typeof x === "string" && x.trim().length > 0).slice(0, 4) : [];
    return {
      verdict,
      explanation: (parsed?.explanation ?? "").trim(),
      foundTitle: (parsed?.foundTitle ?? "").trim(),
      foundAuthors: (parsed?.foundAuthors ?? "").trim(),
      foundYear: (parsed?.foundYear ?? "").trim(),
      evidence,
    };
  }

  // ============================================================
  // Existence checks (no key needed — all CORS-enabled public APIs)
  // ============================================================
  function normalizeTitle(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }
  const STOP = new Set(
    ("the a an and or but nor for to of in on at by from with as into over under between within across " +
      "through during before after above below up down out off about against among per via " +
      "is are was were be been being am do does did done has have had having will would can could may might " +
      "must shall should this that these those there here it its i we you he she they me us him her them my " +
      "our your his their one two also however therefore thus hence not no such same each any some all both " +
      "using used use new toward towards approach method study analysis based effect role case report review results data")
      .split(" "),
  );
  function titleTokens(s, keepStop) {
    const t = normalizeTitle(s).split(" ").filter(Boolean);
    const content = t.filter((w) => !STOP.has(w) && w.length > 1);
    return keepStop || content.length < 2 ? t : content;
  }
  function surname(authors) {
    if (!authors) return "";
    const first = authors.split(/;|,|\band\b|&/)[0].trim();
    const parts = first.split(/\s+/).filter(Boolean);
    const cap = parts.find((p) => /^[A-Z][a-z]+/.test(p) && p.length > 2);
    return normalizeTitle(cap || parts[parts.length - 1] || "");
  }
  function acceptMatch(ref, candTitle, candFamilies, candYear) {
    candFamilies = candFamilies || []; candYear = candYear || "";
    const A = new Set(titleTokens(ref.title ?? "")), B = new Set(titleTokens(candTitle));
    if (!A.size || !B.size) return { ok: false, score: 0 };
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const dice = (2 * inter) / (A.size + B.size);
    const wantSur = surname(ref.authors);
    const wantYr = (String(ref.year || "").match(/\d{4}/) || [])[0];
    const fams = candFamilies.map((f) => normalizeTitle(f)).filter(Boolean);
    const surMatch = !!wantSur && fams.includes(wantSur);
    const yrMatch = !!wantYr && String(candYear).includes(wantYr);
    let ok = false;
    if (surMatch && dice >= 0.6 && inter >= 3) ok = true;
    else if (dice >= 0.8 && inter >= 4) ok = true;
    else if (A.size <= 4 && B.size <= 4 && dice >= 0.85) ok = true;
    else if (surMatch && yrMatch && inter >= 1) ok = true;
    // a near-identical title (of any length) is the same work even if the author list didn't parse —
    // this is what lets a real, paywalled paper whose title clearly matches get confirmed.
    else if (dice >= 0.85 && inter >= 3) ok = true;
    return { ok, score: dice };
  }
  function stripJats(s) {
    if (!s) return undefined;
    return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
  }
  function reconstructAbstract(inv) {
    if (!inv || typeof inv !== "object") return undefined;
    const words = [];
    for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
    const out = words.filter((w) => w != null).join(" ").replace(/\s+/g, " ").trim();
    return out || undefined;
  }
  function mailtoParam() {
    const e = getSettings().email;
    return e ? `&mailto=${encodeURIComponent(e)}` : "";
  }
  // The DOI may be in the parsed .doi field, buried in a doi.org link, or sitting in the raw citation
  // string — grab it from wherever it is so a "web link" reference can still resolve to its real record.
  function extractDoi(ref) {
    const d = (ref.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    if (/^10\.\d{4,9}\//.test(d)) return d;
    const hay = `${ref.url || ""} ${ref.raw || ""}`;
    const m = hay.match(/10\.\d{4,9}\/[^\s"'<>)\]}]+/);
    return m ? m[0].replace(/[.,;]+$/, "").trim() : "";
  }

  async function crossrefCheck(ref) {
    try {
      const doi0 = extractDoi(ref);
      if (doi0) {
        // encodeURI (NOT encodeURIComponent): CrossRef's /works/{doi} endpoint 400s on a percent-encoded
        // slash (%2F) but resolves fine with the raw slash a DOI needs.
        const r = await fetchRetry(`https://api.crossref.org/works/${encodeURI(doi0)}${mailtoParam() ? "?" + mailtoParam().slice(1) : ""}`);
        if (r.ok) {
          const j = await r.json();
          const item = j?.message;
          if (item?.DOI) {
            return { exists: true, source: "crossref", doi: item.DOI, crossrefUrl: `https://doi.org/${item.DOI}`,
              matchedTitle: item.title?.[0], abstract: stripJats(item.abstract) };
          }
        }
      }
      const queries = [];
      const tq = [ref.title, ref.authors].filter(Boolean).join(" ").trim();
      if (tq) queries.push(tq);
      const titleOnly = (ref.title ?? "").trim();
      if (titleOnly && titleOnly !== tq) queries.push(titleOnly);
      if (!queries.length) return { exists: false, source: "" };
      let bestTitle, bestScore = 0;
      const seen = new Set();
      for (const q of queries) {
        const r = await fetchRetry(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=8&select=DOI,title,author,issued,abstract${mailtoParam()}`);
        if (!r.ok) continue;
        const j = await r.json();
        const items = j?.message?.items ?? [];
        for (const item of items) {
          const t = item.title?.[0] ?? "";
          const key = String(item.DOI || t).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          if (doi0 && item.DOI && doi0.toLowerCase().includes(String(item.DOI).toLowerCase())) {
            return { exists: true, source: "crossref", doi: item.DOI, crossrefUrl: `https://doi.org/${item.DOI}`,
              matchedTitle: t, abstract: stripJats(item.abstract) };
          }
          const fams = (item.author || []).map((a) => a.family || "");
          const yr = (item.issued?.["date-parts"]?.[0]?.[0] || "").toString();
          const m = acceptMatch(ref, t, fams, yr);
          if (m.ok) {
            return { exists: true, source: "crossref", doi: item.DOI,
              crossrefUrl: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
              matchedTitle: t, abstract: stripJats(item.abstract) };
          }
          if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
        }
      }
      return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
    } catch { return { exists: false, source: "" }; }
  }

  function ncbi(path, params) {
    const u = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}`);
    u.searchParams.set("tool", "refcheck");
    const e = getSettings().email; if (e) u.searchParams.set("email", e);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
  async function pubmedCheck(ref) {
    try {
      const title = (ref.title ?? "").trim();
      if (!title) return { exists: false, source: "" };
      const yr = (String(ref.year || "").match(/\d{4}/) || [])[0];
      const surn = surname(ref.authors);
      const attempts = [];
      if (yr) attempts.push(`${title} AND ${yr}[pdat]`);
      attempts.push(title);
      if (surn) attempts.push(`${title} ${surn}`);
      let ids = [];
      for (const term of attempts) {
        const sr = await fetchRetry(ncbi("esearch.fcgi", { db: "pubmed", term, retmode: "json", retmax: "5" }));
        if (!sr.ok) continue;
        const sj = await sr.json();
        ids = sj?.esearchresult?.idlist ?? [];
        if (ids.length) break;
      }
      if (!ids.length) return { exists: false, source: "" };
      const er = await fetchRetry(ncbi("esummary.fcgi", { db: "pubmed", id: ids.join(","), retmode: "json" }));
      if (!er.ok) return { exists: false, source: "" };
      const ej = await er.json();
      const res = ej?.result ?? {};
      let bestTitle, bestScore = 0;
      for (const id of ids) {
        const cand = res[id];
        const candTitle = (cand?.title ?? "").replace(/\.$/, "");
        const fams = (cand?.authors || []).map((a) => (a.name || "").split(/\s+/)[0]);
        const cy = (String(cand?.pubdate || "").match(/\d{4}/) || [])[0] || "";
        const m = acceptMatch(ref, candTitle, fams, cy);
        if (m.ok) {
          const pubtypes = (Array.isArray(cand?.pubtype) ? cand.pubtype : []).map((x) => String(x).toLowerCase());
          const retracted = pubtypes.includes("retracted publication");
          return { exists: true, source: "pubmed", pmid: id,
            pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, matchedTitle: candTitle,
            retracted: retracted || undefined,
            retractionNote: retracted ? "PubMed lists this article as a Retracted Publication." : undefined };
        }
        if (m.score > bestScore) { bestScore = m.score; bestTitle = candTitle; }
      }
      return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
    } catch { return { exists: false, source: "" }; }
  }

  async function openAlexCheck(ref) {
    try {
      const title = (ref.title ?? "").trim();
      if (!title) return { exists: false, source: "" };
      const u = new URL("https://api.openalex.org/works");
      u.searchParams.set("search", title);
      u.searchParams.set("per_page", "5");
      const e = getSettings().email; if (e) u.searchParams.set("mailto", e);
      const r = await fetchRetry(u.toString());
      if (!r.ok) return { exists: false, source: "" };
      const j = await r.json();
      const items = j?.results ?? [];
      let bestTitle, bestScore = 0;
      for (const it of items) {
        const t = it?.title || it?.display_name || "";
        if (!t) continue;
        const fams = (it?.authorships || []).map((a) => ((a?.author?.display_name || a?.raw_author_name || "").trim().split(/\s+/).pop() || ""));
        const yr = String(it?.publication_year || "");
        const m = acceptMatch(ref, t, fams, yr);
        if (m.ok) {
          const doi = String(it?.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
          const retracted = it?.is_retracted === true;
          return { exists: true, source: "openalex", doi: doi || undefined,
            crossrefUrl: it?.doi || (it?.id ? String(it.id) : undefined), matchedTitle: t,
            abstract: reconstructAbstract(it?.abstract_inverted_index),
            retracted: retracted || undefined,
            retractionNote: retracted ? "OpenAlex marks this work as retracted." : undefined };
        }
        if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
      }
      return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
    } catch { return { exists: false, source: "" }; }
  }

  async function dataciteCheck(ref) {
    try {
      // direct DOI resolution first: a DOI CrossRef doesn't index (datasets, theses, some publishers)
      // still confirms existence if DataCite resolves it.
      const doi0 = (ref.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
      if (doi0) {
        const dr = await fetchRetry(`https://api.datacite.org/dois/${encodeURIComponent(doi0)}`);
        if (dr.ok) {
          const dj = await dr.json();
          const at = dj?.data?.attributes;
          if (at && (at.doi || dj?.data?.id)) {
            const doi = String(at.doi || doi0).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
            return { exists: true, source: "datacite", doi, crossrefUrl: `https://doi.org/${doi}`,
              matchedTitle: at?.titles?.[0]?.title, abstract: stripJats(at?.descriptions?.[0]?.description) };
          }
        }
      }
      const title = (ref.title ?? "").trim();
      if (!title) return { exists: false, source: "" };
      const u = new URL("https://api.datacite.org/dois");
      u.searchParams.set("query", title);
      u.searchParams.set("page[size]", "5");
      const r = await fetchRetry(u.toString());
      if (!r.ok) return { exists: false, source: "" };
      const j = await r.json();
      const items = j?.data ?? [];
      let bestTitle, bestScore = 0;
      for (const it of items) {
        const at = it?.attributes ?? {};
        const t = at?.titles?.[0]?.title || "";
        if (!t) continue;
        const fams = (at?.creators || []).map((c) => (c?.familyName || String(c?.name || "").split(",")[0] || "").trim());
        const yr = String(at?.publicationYear || "");
        const m = acceptMatch(ref, t, fams, yr);
        if (m.ok) {
          const doi = String(at?.doi || it?.id || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
          return { exists: true, source: "datacite", doi: doi || undefined,
            crossrefUrl: doi ? `https://doi.org/${doi}` : undefined, matchedTitle: t };
        }
        if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
      }
      return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
    } catch { return { exists: false, source: "" }; }
  }

  async function googleBooksCheck(ref) {
    try {
      const title = (ref.title ?? "").trim();
      if (!title) return { exists: false, source: "" };
      const u = new URL("https://www.googleapis.com/books/v1/volumes");
      u.searchParams.set("q", `intitle:${title}`);
      u.searchParams.set("maxResults", "5");
      u.searchParams.set("country", "US");
      const r = await fetchRetry(u.toString());
      if (!r.ok) return { exists: false, source: "" };
      const j = await r.json();
      const items = j?.items ?? [];
      let bestTitle, bestScore = 0;
      for (const it of items) {
        const vi = it?.volumeInfo ?? {};
        const t = [vi?.title, vi?.subtitle].filter(Boolean).join(": ");
        if (!t) continue;
        const fams = (vi?.authors || []).map((a) => (a.trim().split(/\s+/).pop() || ""));
        const yr = (String(vi?.publishedDate || "").match(/\d{4}/) || [])[0] || "";
        const m = acceptMatch(ref, t, fams, yr);
        if (m.ok) {
          return { exists: true, source: "googlebooks", matchedTitle: t,
            webUrl: vi?.infoLink || vi?.canonicalVolumeLink || undefined,
            abstract: typeof vi?.description === "string" ? vi.description : undefined };
        }
        if (m.score > bestScore) { bestScore = m.score; bestTitle = t; }
      }
      return { exists: false, source: "", matchedTitle: bestScore >= 0.55 ? bestTitle : undefined };
    } catch { return { exists: false, source: "" }; }
  }

  // Web/news sources: a browser can't fetch arbitrary sites (CORS), so instead of loading the page we
  // ask the Internet Archive's Wayback Machine whether a snapshot exists — a good "this URL is a real,
  // archived web resource" signal, and Wayback's availability API is CORS-enabled.
  function extractUrl(ref) {
    let u = (ref.url ?? "").trim();
    if (!u) { const m = (ref.raw ?? "").match(/https?:\/\/[^\s)\]}"'>]+/i); if (m) u = m[0]; }
    if (!u) { const m = (ref.raw ?? "").match(/\bwww\.[^\s)\]}"'>]+/i); if (m) u = "https://" + m[0]; }
    return u.replace(/[.,;>)\]]+$/, "").trim();
  }
  function isPublicHttpUrl(u) {
    let url;
    try { url = new URL(u); } catch { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1|fe80:|fc00:|fd00:)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  }
  async function webCheck(ref) {
    const url = extractUrl(ref);
    if (!url || !isPublicHttpUrl(url)) return { exists: false, source: "", webStatus: "no-url" };
    try {
      const r = await fetchRetry(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
      if (!r.ok) return { exists: false, source: "", webUrl: url, webStatus: "unreachable" };
      const j = await r.json();
      const snap = j?.archived_snapshots?.closest;
      if (snap && snap.available) {
        return { exists: true, source: "web", webUrl: url, webStatus: "archived", matchedTitle: "" };
      }
      return { exists: false, source: "", webUrl: url, webStatus: "not-archived" };
    } catch { return { exists: false, source: "", webUrl: url, webStatus: "unreachable" }; }
  }

  async function openAlexRetractedByDoi(doi) {
    try {
      const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
      if (!clean) return false;
      const u = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}?select=is_retracted${mailtoParam()}`;
      const r = await fetchRetry(u);
      if (!r.ok) return false;
      const j = await r.json();
      return j?.is_retracted === true;
    } catch { return false; }
  }
  async function augmentRetraction(hit) {
    if (hit.retracted) return hit;
    if (hit.source === "pubmed" || hit.source === "openalex") return hit;
    if (hit.doi && await openAlexRetractedByDoi(hit.doi)) {
      return { ...hit, retracted: true, retractionNote: "OpenAlex marks this DOI as retracted." };
    }
    return hit;
  }

  // A confirmed reference (esp. via CrossRef, which rarely returns abstracts) often has no text for the
  // citation-accuracy check. Fetch the abstract from OpenAlex (huge coverage) or Europe PMC (biomedical)
  // so claims CAN be checked against the source's own words even when the full paper is paywalled.
  async function augmentAbstract(hit, ref) {
    if (!hit.exists || (hit.abstract && hit.abstract.length > 40)) return hit;
    const doi = (hit.doi || ref.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    // 1) OpenAlex — by DOI, then by title
    try {
      let work = null;
      if (doi) {
        const r = await fetchRetry(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=abstract_inverted_index${mailtoParam()}`);
        if (r.ok) work = await r.json();
      }
      if (!work && ref.title) {
        const u = new URL("https://api.openalex.org/works");
        u.searchParams.set("search", ref.title);
        u.searchParams.set("per_page", "1");
        u.searchParams.set("select", "abstract_inverted_index,title");
        const e = getSettings().email; if (e) u.searchParams.set("mailto", e);
        const r = await fetchRetry(u.toString());
        if (r.ok) { const j = await r.json(); work = (j?.results || [])[0] || null; }
      }
      const abs = work ? reconstructAbstract(work.abstract_inverted_index) : undefined;
      if (abs && abs.length > 40) return { ...hit, abstract: abs };
    } catch (_) {}
    // 2) Europe PMC fallback (biomedical) — by DOI, then by title
    try {
      const q = doi ? `DOI:"${doi}"` : (ref.title ? `TITLE:"${ref.title.replace(/"/g, "")}"` : "");
      if (q) {
        const r = await fetchRetry(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&resultType=core&format=json&pageSize=1`);
        if (r.ok) {
          const j = await r.json();
          const abs = j?.resultList?.result?.[0]?.abstractText;
          if (abs) { const clean = stripJats(abs); if (clean && clean.length > 40) return { ...hit, abstract: clean }; }
        }
      }
    } catch (_) {}
    return hit;
  }

  // Public, on-demand version: fetch an abstract for a reference at citation-accuracy time (no Gemini
  // key needed — OpenAlex/Europe PMC/CrossRef are all CORS-open). Used to fill in refs whose abstract
  // wasn't captured during analysis, so more citations become checkable instead of "no source".
  async function fetchAbstract(ref) {
    if (!ref) return "";
    const out = await augmentAbstract({ exists: true, doi: extractDoi(ref), abstract: "" }, ref);
    return out && out.abstract ? out.abstract : "";
  }

  async function verifyExistence(ref) {
    let hit = null;
    const cr = await crossrefCheck(ref);
    if (cr.exists) hit = cr;
    let pm, oa, dc, gb, web;
    if (!hit) { pm = await pubmedCheck(ref); if (pm.exists) hit = { ...pm, doi: pm.doi ?? cr.doi, crossrefUrl: pm.crossrefUrl ?? cr.crossrefUrl }; }
    if (!hit) { oa = await openAlexCheck(ref); if (oa.exists) hit = { ...oa, doi: oa.doi ?? cr.doi, crossrefUrl: oa.crossrefUrl ?? cr.crossrefUrl }; }
    if (!hit) { dc = await dataciteCheck(ref); if (dc.exists) hit = { ...dc, doi: dc.doi ?? cr.doi, crossrefUrl: dc.crossrefUrl ?? cr.crossrefUrl }; }
    if (!hit) { gb = await googleBooksCheck(ref); if (gb.exists) hit = { ...gb, doi: cr.doi, crossrefUrl: cr.crossrefUrl }; }
    if (!hit) { web = await webCheck(ref); if (web.exists) hit = { ...web, doi: cr.doi, crossrefUrl: cr.crossrefUrl }; }
    if (hit) { hit = await augmentAbstract(hit, ref); return await augmentRetraction(hit); }
    return {
      exists: false, source: "", doi: cr.doi, crossrefUrl: cr.crossrefUrl,
      matchedTitle: cr.matchedTitle ?? pm?.matchedTitle ?? oa?.matchedTitle ?? dc?.matchedTitle ?? gb?.matchedTitle ?? web?.matchedTitle,
      webUrl: web?.webUrl, webStatus: web?.webStatus,
    };
  }
  async function verifyAll(refs) {
    const out = new Array(refs.length);
    let idx = 0;
    async function worker() { while (idx < refs.length) { const i = idx++; out[i] = await verifyExistence(refs[i]); } }
    await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));
    return out;
  }

  const SOURCE_LABEL = {
    crossref: "CrossRef", pubmed: "PubMed", openalex: "OpenAlex",
    datacite: "DataCite", googlebooks: "Google Books", web: "the Internet Archive", "": "a database",
  };
  function reconcile(ref, cr) {
    let verdict = ref.verdict ?? "review";
    let reason = ref.reason ?? "";
    const where = SOURCE_LABEL[cr.source] || "a database";
    if (cr.exists) {
      // FOUND in a database (or archived) => the cited work is REAL => verified. Existence is stronger
      // evidence than any AI plausibility guess, so a database hit overrides an AI "flag". We mark it
      // verified even when the full text is paywalled/unreadable — being real is what "verified" means.
      verdict = "verified";
      const found = cr.source === "web"
        ? `Confirmed real — a snapshot of the cited link exists in the Internet Archive.`
        : `Confirmed real — found in ${where}.`;
      reason = `${found} (Verified because the work exists; the full text may still be behind a paywall.) ` + reason;
    } else {
      const webNote =
        cr.webStatus === "not-archived"
          ? `The cited web link isn't in the Internet Archive, so it couldn't be auto-confirmed — open it manually to check. `
          : cr.webStatus === "unreachable"
          ? `The cited web link couldn't be checked automatically — please verify it manually. `
          : "";
      if (verdict === "verified") {
        verdict = "review";
        reason = webNote +
          `Not found in CrossRef, PubMed, OpenAlex, DataCite, or Google Books — this can still happen for some books, theses, conference papers, preprints, non-indexed journals, and news/website sources, so confirm it manually rather than assuming it is fake. ` +
          reason;
      } else if (verdict === "flagged") {
        if ((ref.confidence ?? 0) >= 0.85) {
          reason = webNote +
            `The AI judged this likely fabricated (high confidence) and it could not be confirmed in CrossRef, PubMed, OpenAlex, DataCite, Google Books, or the Internet Archive. ` + reason;
        } else {
          verdict = "review";
          reason = webNote + `Could not automatically verify this reference — please confirm it manually. ` + reason;
        }
      } else if (webNote) {
        reason = webNote + reason;
      }
    }
    if (cr.retracted) {
      reason = `RETRACTED: ${cr.retractionNote || "This publication has been retracted and should not be cited as valid evidence."} ` + reason;
      if (verdict === "verified") verdict = "review";
    }
    return { verdict, reason: reason.trim(), retracted: !!cr.retracted };
  }

  // ============================================================
  // Router — mirrors the old Edge Function's request/response shape.
  // Returns { data, error } just like sb.functions.invoke did, so app-ui.js barely changes.
  // ============================================================
  async function run(body) {
    body = body || {};
    try {
      // ---- claim vs. cited paper ----
      if (body.action === "cite") {
        const claim = (body.claim ?? "").toString().trim();
        const paperText = (body.paperText ?? "").toString();
        if (!claim) return { data: null, error: { message: "No claim was provided." } };
        if (!paperText.trim()) return { data: null, error: { message: "No cited-paper text was provided." } };
        const basis = body.basis === "abstract" ? "abstract" : "full text";
        const strictness = body.strictness === "critical" ? "critical" : "broad";
        const out = await assessCitation(claim, paperText, (body.paperTitle ?? "").toString(), basis, strictness);
        return { data: { ...out, basis }, error: null };
      }
      // ---- is this PDF the cited work? ----
      if (body.action === "match") {
        const paperText = (body.paperText ?? "").toString();
        const ref = body.ref ?? {};
        if (!paperText.trim()) return { data: null, error: { message: "No source-PDF text was provided." } };
        if (!(ref.title || ref.raw)) return { data: null, error: { message: "No reference was provided to match against." } };
        const out = await assessMatch(ref, paperText);
        return { data: out, error: null };
      }
      // ---- default: extract + verify references ----
      let text = (body.referencesText ?? "").toString();
      const filename = (body.filename ?? "manuscript").toString().slice(0, 200);
      if (!text.trim()) return { data: null, error: { message: "No references text was provided." } };
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

      const gemini = await analyzeReferences(text);
      const allRefs = gemini.references;
      if (!allRefs.length) return { data: null, error: { message: "No references could be extracted from that document." } };
      const refs = allRefs.slice(0, MAX_REFS);
      const overflow = allRefs.slice(MAX_REFS);
      const verify = await verifyAll(refs);

      const references = refs.map((ref, i) => {
        const cr = verify[i] ?? { exists: false, source: "" };
        const { verdict, reason, retracted } = reconcile(ref, cr);
        return {
          id: ref.id, raw: ref.raw, authors: ref.authors ?? "", title: ref.title ?? "",
          year: ref.year ?? "", journal: ref.journal ?? "", doi: cr.doi ?? ref.doi ?? "",
          marker: ref.marker ?? "", confidence: typeof ref.confidence === "number" ? ref.confidence : null,
          exists: cr.exists, source: cr.source ?? "", crossrefUrl: cr.crossrefUrl ?? "",
          pmid: cr.pmid ?? "", pubmedUrl: cr.pubmedUrl ?? "", url: ref.url ?? extractUrl(ref) ?? "",
          webUrl: cr.webUrl ?? "", webStatus: cr.webStatus ?? "", matchedTitle: cr.matchedTitle ?? "",
          abstract: cr.abstract ?? "", retracted: !!retracted, verdict, reason,
        };
      });
      for (const ref of overflow) {
        references.push({
          id: ref.id, raw: ref.raw, authors: ref.authors ?? "", title: ref.title ?? "",
          year: ref.year ?? "", journal: ref.journal ?? "", doi: ref.doi ?? "", marker: ref.marker ?? "",
          confidence: typeof ref.confidence === "number" ? ref.confidence : null,
          exists: false, source: "", crossrefUrl: "", pmid: "", pubmedUrl: "",
          url: ref.url ?? extractUrl(ref) ?? "", webUrl: "", webStatus: "", matchedTitle: "",
          abstract: "", retracted: false, verdict: "review",
          reason: `This document has more than ${MAX_REFS} references; this one was extracted but not auto-verified in this run — please check it manually. ` + (ref.reason ?? ""),
        });
      }
      const counts = {
        verified: references.filter((r) => r.verdict === "verified").length,
        review: references.filter((r) => r.verdict === "review").length,
        flagged: references.filter((r) => r.verdict === "flagged").length,
      };
      const total = references.length;
      const integrityScore = Math.round((100 * (counts.verified + 0.5 * counts.review)) / total);
      return { data: { filename, total, counts, integrityScore, citationStyle: gemini.citationStyle, references }, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : "Analysis failed." } };
    }
  }

  window.RefCheckCore = { getSettings, saveSettings, usageToday, detectModels, run, fetchAbstract };
})();

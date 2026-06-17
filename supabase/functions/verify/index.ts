// ============================================================
// REF/CHECK — `verify` Edge Function (Deno)
// Holds the Gemini API key server-side (secret), never exposed to the browser.
// Flow: receives the manuscript's References text → Gemini extracts + judges each
// reference → CrossRef confirms existence → reconcile into a scored report.
// ============================================================

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const MAX_CHARS = 60_000;   // cap input to control token cost
const MAX_REFS = 40;        // cap CrossRef lookups
const CROSSREF_CONCURRENCY = 5;

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
  marker?: string;
  verdict?: "verified" | "review" | "flagged";
  confidence?: number;
  reason?: string;
}

interface GeminiResult {
  citationStyle: "numbered" | "author-year" | "unknown";
  references: GeminiRef[];
}

// ---- Gemini: extract + judge in a single structured call ----
async function analyzeWithGemini(referencesText: string): Promise<GeminiResult> {
  const prompt = `You are an academic integrity assistant. Below is the References/Bibliography
section of a manuscript. Determine the citation style and extract EVERY individual reference, analyzing each.

First decide citationStyle:
- "numbered": references are numbered (1., [1], (1)…) and cited in-text as [1]/(1)/superscripts
- "author-year": references have no numbers and are cited in-text as (Surname, Year)
- "unknown": cannot tell

For each reference return:
- raw: the full reference string as written
- authors, title, year, journal, doi (best-effort parse; empty string if absent)
- marker: the token used to find this reference IN THE BODY TEXT. For numbered style use the
  reference's number only (e.g. "12"). For author-year use "Surname YEAR" using the FIRST author's
  surname and the year (e.g. "Smith 2020"). Empty string if unknown.
- verdict: one of "verified" | "review" | "flagged"
    • "verified": looks like a real, well-formed, plausible publication
    • "review": real-looking but with inconsistencies, missing info, or details that don't add up
    • "flagged": likely fabricated/hallucinated (implausible authors+title+venue combo, fake-looking DOI, nonsensical)
- confidence: 0..1 for your verdict
- reason: one concise, specific sentence explaining the verdict

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
        temperature: 0.2,
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

// ---- CrossRef existence check ----
function normalizeTitle(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const B = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}

interface CrossrefResult {
  exists: boolean;
  doi?: string;
  crossrefUrl?: string;
  matchedTitle?: string;
}

async function crossrefCheck(ref: GeminiRef): Promise<CrossrefResult> {
  try {
    // 1) direct DOI lookup if we have one
    if (ref.doi) {
      const clean = ref.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
      const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, {
        headers: { "User-Agent": "RefCheck/1.0 (mailto:support@ref-check.ai)" },
      });
      if (r.ok) {
        const j = await r.json();
        const item = j?.message;
        if (item?.DOI) {
          return {
            exists: true,
            doi: item.DOI,
            crossrefUrl: `https://doi.org/${item.DOI}`,
            matchedTitle: item.title?.[0],
          };
        }
      }
    }
    // 2) bibliographic title/author query
    const query = [ref.title, ref.authors].filter(Boolean).join(" ");
    if (!query.trim()) return { exists: false };
    const r = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=1`,
      { headers: { "User-Agent": "RefCheck/1.0 (mailto:support@ref-check.ai)" } },
    );
    if (!r.ok) return { exists: false };
    const j = await r.json();
    const item = j?.message?.items?.[0];
    if (!item) return { exists: false };
    const sim = titleSimilarity(ref.title ?? "", item.title?.[0] ?? "");
    if (sim >= 0.6) {
      return {
        exists: true,
        doi: item.DOI,
        crossrefUrl: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
        matchedTitle: item.title?.[0],
      };
    }
    return { exists: false, matchedTitle: item.title?.[0] };
  } catch {
    return { exists: false };
  }
}

// run CrossRef checks with limited concurrency
async function crossrefAll(refs: GeminiRef[]): Promise<CrossrefResult[]> {
  const out: CrossrefResult[] = new Array(refs.length);
  let idx = 0;
  async function worker() {
    while (idx < refs.length) {
      const i = idx++;
      out[i] = await crossrefCheck(refs[i]);
    }
  }
  await Promise.all(Array.from({ length: CROSSREF_CONCURRENCY }, worker));
  return out;
}

// ---- reconcile Gemini verdict + CrossRef existence ----
function reconcile(ref: GeminiRef, cr: CrossrefResult) {
  let verdict = ref.verdict ?? "review";
  let reason = ref.reason ?? "";

  if (cr.exists) {
    // confirmed real; only downgrade to review if the model was unsure
    if (verdict === "flagged") {
      verdict = "review";
      reason = "Found in CrossRef, but some details may not match — worth a look. " + reason;
    } else if (verdict !== "verified" && (ref.confidence ?? 1) >= 0.6) {
      verdict = "verified";
    }
  } else {
    // not found in CrossRef
    if (verdict === "verified") {
      verdict = "review";
      reason = "Looks plausible but no CrossRef match was found — verify manually. " + reason;
    } else if (verdict === "review" && (ref.confidence ?? 0) >= 0.7) {
      verdict = "flagged";
    }
  }
  return { verdict, reason: reason.trim() };
}

// ---- handler ----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!GEMINI_API_KEY) {
    return json({ error: "Server is missing GEMINI_API_KEY. Set it with `supabase secrets set`." }, 500);
  }

  let body: { filename?: string; referencesText?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const filename = (body.filename ?? "manuscript").toString().slice(0, 200);
  let text = (body.referencesText ?? "").toString();
  if (!text.trim()) return json({ error: "No references text was provided." }, 400);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  try {
    // 1) Gemini extract + judge
    const gemini = await analyzeWithGemini(text);
    let refs = gemini.references;
    if (!refs.length) {
      return json({ error: "No references could be extracted from that document." }, 422);
    }
    refs = refs.slice(0, MAX_REFS);

    // 2) CrossRef existence checks
    const crossref = await crossrefAll(refs);

    // 3) reconcile
    const references = refs.map((ref, i) => {
      const cr = crossref[i] ?? { exists: false };
      const { verdict, reason } = reconcile(ref, cr);
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
        crossrefUrl: cr.crossrefUrl ?? "",
        matchedTitle: cr.matchedTitle ?? "",
        verdict,
        reason,
      };
    });

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

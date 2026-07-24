// ============================================================
// REF/CHECK AI — app workspace logic (fully local: no login, no cloud)
// file upload → client-side text extraction (pdf.js / mammoth)
// → RefCheckCore.run() (Gemini with your key + CrossRef/OpenAlex/etc. in the browser)
// → render → save to localStorage (this machine only).
// ============================================================
(function () {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const Core = window.RefCheckCore;

  // ---- local analysis store (replaces the old Supabase `analyses`/`feedback` tables) ----
  // One localStorage array of records; each holds everything needed to rebuild a past analysis.
  const STORE_KEY = "refcheck-analyses";
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]") || []; } catch (_) { return []; }
  }
  function saveStore(arr) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr.slice(0, 50))); } catch (_) {}
  }
  function storeGet(id) { return loadStore().find((r) => r.id === id) || null; }
  function storeUpsert(rec) {
    const arr = loadStore();
    const i = arr.findIndex((r) => r.id === rec.id);
    if (i >= 0) arr[i] = { ...arr[i], ...rec };
    else arr.unshift(rec);
    saveStore(arr);
  }
  function newId() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return "a" + Date.now() + Math.random().toString(36).slice(2, 8);
  }

  // pdf.js worker
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  // ---- element refs ----
  const $ = (id) => document.getElementById(id);
  const gate = $("gate"), app = $("app");
  const viewUpload = $("view-upload"), viewProcessing = $("view-processing"), viewResults = $("view-results");
  const fileInput = $("file-input"), dropzone = $("dropzone");
  const fileSelected = $("file-selected"), fileNameEl = $("file-name"), fileMetaEl = $("file-meta"), fileIcon = $("file-icon");
  const analyzeBtn = $("analyze-btn"), uploadError = $("upload-error");
  const historyList = $("history-list"), historyEmpty = $("history-empty"), historyCount = $("history-count");

  let currentFile = null;
  let currentResult = null;
  let activeFilter = "all";
  let userEmail = "";

  // Phase 3 state (per-analysis; source PDFs live only in memory)
  let sourcePapers = [];      // {id, filename, text, title, refId, loading, error}
  let citationInstances = []; // {id, refId, start, claim}
  let citeResults = {};       // instanceId -> {status, assessment, explanation, basis, error}
  let srcIdSeq = 0;

  // Phase 4 feedback state: "feature:item_key" -> {rating, comment}
  let feedbackMap = {};

  // Phase 5A batch state
  let batchFiles = [];
  let batchStatuses = {};

  // ============================================================
  // Boot — no login; open straight into the workspace
  // ============================================================
  (function init() {
    if (gate) gate.classList.add("hidden");
    if (app) app.classList.remove("hidden");
    initInteractions();
    wirePhase3();
    wireSettings();
    loadHistory();
    loadAppStat();
  })();

  // Local usage stat: how many manuscripts this browser has checked.
  function loadAppStat() {
    const el = $("app-stat");
    if (!el) return;
    const arr = loadStore();
    if (!arr.length) return;
    const refs = arr.reduce((n, r) => n + ((r.results && r.results.length) || 0), 0);
    el.textContent = `You've checked ${arr.length} manuscript${arr.length === 1 ? "" : "s"} and ${refs} reference${refs === 1 ? "" : "s"} on this device.`;
    el.classList.remove("hidden");
  }

  // ============================================================
  // File selection
  // ============================================================
  const MAX_BYTES = 20 * 1024 * 1024;
  function setError(msg) {
    if (!msg) { uploadError.classList.add("hidden"); return; }
    uploadError.textContent = msg; uploadError.classList.remove("hidden");
  }
  function humanSize(b) { return b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB"; }

  function selectFile(file) {
    setError("");
    if (!file) return;
    const name = file.name.toLowerCase();
    const isPdf = name.endsWith(".pdf"), isDocx = name.endsWith(".docx");
    if (!isPdf && !isDocx) { setError("Please upload a PDF or DOCX file."); return; }
    if (file.size > MAX_BYTES) { setError("That file is larger than 20 MB."); return; }
    currentFile = file;
    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = humanSize(file.size) + " · " + (isPdf ? "PDF" : "DOCX");
    fileIcon.textContent = isPdf ? "picture_as_pdf" : "description";
    fileSelected.classList.remove("hidden");
    analyzeBtn.disabled = false;
  }

  fileInput.addEventListener("change", (e) => selectFiles(e.target.files));
  $("file-remove").addEventListener("click", () => {
    currentFile = null; fileInput.value = "";
    fileSelected.classList.add("hidden"); analyzeBtn.disabled = true; setError("");
  });

  // Route one or many files: a single file uses the normal flow; 2+ go to the batch queue.
  function selectFiles(fileList) {
    setError("");
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const valid = [];
    files.forEach((f) => {
      const n = f.name.toLowerCase();
      if ((n.endsWith(".pdf") || n.endsWith(".docx")) && f.size <= MAX_BYTES) valid.push(f);
    });
    if (!valid.length) { setError("Please upload PDF or DOCX files up to 20 MB each."); return; }
    if (valid.length === 1) { clearBatch(); selectFile(valid[0]); return; }
    // batch mode
    currentFile = null; fileSelected.classList.add("hidden");
    analyzeBtn.classList.add("hidden");
    batchFiles = valid; batchStatuses = {};
    batchFiles.forEach((_, i) => (batchStatuses[i] = { status: "queued" }));
    renderBatch();
    $("batch-panel").classList.remove("hidden");
  }
  function clearBatch() {
    batchFiles = []; batchStatuses = {};
    $("batch-panel").classList.add("hidden");
    analyzeBtn.classList.remove("hidden");
  }

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) selectFiles(e.dataTransfer.files);
  });

  // ---- batch queue (Phase 5A) ----
  function renderBatch() {
    $("batch-count").textContent = `${batchFiles.length} files`;
    $("batch-start-label").textContent = `Process ${batchFiles.length} manuscripts`;
    const ICON = {
      queued: ["schedule", "text-ink-mute"], extracting: ["description", "text-ink-soft"],
      analyzing: ["neurology", "text-ink-soft"], done: ["check_circle", "text-ok"], error: ["error", "text-bad"],
    };
    $("batch-list").innerHTML = batchFiles.map((f, i) => {
      const st = batchStatuses[i] || { status: "queued" };
      const [icon, cls] = ICON[st.status] || ICON.queued;
      const right = st.status === "done" ? `<span class="font-mono text-[11px] text-ok">${st.score}</span>`
        : st.status === "error" ? `<span class="text-[11px] text-bad">${escapeHtml(st.error || "failed")}</span>`
        : st.status === "queued" ? '<span class="text-[11px] text-ink-mute">queued</span>'
        : '<span class="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0"></span>';
      return `<div class="glass rounded-lg p-2.5 flex items-center gap-2.5">
        <span class="material-symbols-outlined text-[18px] ${cls} shrink-0">${icon}</span>
        <span class="text-sm text-white truncate flex-grow">${escapeHtml(f.name)}</span>
        ${right}
      </div>`;
    }).join("");
  }
  async function processBatch() {
    if (!batchFiles.length) return;
    const startBtn = $("batch-start"); startBtn.disabled = true;
    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      try {
        batchStatuses[i] = { status: "extracting" }; renderBatch();
        const isPdf = f.name.toLowerCase().endsWith(".pdf");
        const fullText = isPdf ? await extractPdf(f) : await extractDocx(f);
        if (!fullText || fullText.replace(/\s/g, "").length < 40) throw new Error("no readable text");
        const { slice: referencesText, bodyEnd } = sliceReferences(fullText);
        batchStatuses[i] = { status: "analyzing" }; renderBatch();
        const { data, error } = await Core.run({ filename: f.name, referencesText });
        if (error) throw new Error(error.message || "failed");
        if (data && data.error) throw new Error(data.error);
        const result = { ...data, fullText, bodyEnd, created_at: new Date().toISOString() };
        await persist(result);
        batchStatuses[i] = { status: "done", score: data.integrityScore }; renderBatch();
        loadHistory();
      } catch (err) {
        batchStatuses[i] = { status: "error", error: (err.message || "failed").slice(0, 40) }; renderBatch();
      }
    }
    startBtn.disabled = false;
  }

  // ============================================================
  // Text extraction (client side — no key needed)
  // ============================================================
  async function extractPdf(file) {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map((it) => it.str).join(" ") + "\n";
    }
    return text;
  }
  async function extractDocx(file) {
    const buf = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return res.value || "";
  }

  // Locate the References / Bibliography section. Returns the slice (for the model)
  // and the boundary index so highlighting can be limited to the body before it.
  function sliceReferences(fullText) {
    // Find the References/Bibliography heading. PDF text extraction is messy: the heading may sit on
    // its own line, be glued to the first entry ("References1. Smith…"), carry a leading section
    // number ("7. References"), or be ALL CAPS. So we look for the heading token near a line start
    // and only accept it when a reference-LIST actually follows (a numbered entry or an author-year
    // start) — that both catches glued headings and rejects the word "references" used in prose.
    const re = /(?:^|\n)[ \t]*(?:\d{1,2}[.)]\s*)?(references|bibliography|works cited|literature cited|reference list)\b[ \t]*:?[ \t]*/gi;
    const looksLikeListStart = /^[\s]*(\[?\(?\d{1,3}[.)\]]|\d{1,3}\s+[A-Z]|[A-Z][A-Za-z'’-]+,\s+[A-Z])/;
    let headStart = -1, m;
    while ((m = re.exec(fullText)) !== null) {
      const after = fullText.slice(re.lastIndex, re.lastIndex + 220);
      if (looksLikeListStart.test(after)) headStart = m.index; // keep the LAST qualifying heading
    }
    // fallback: original strict "heading alone on its own line" match (covers author-year lists that
    // don't start with a digit and whose first surname the stricter probe might miss)
    if (headStart < 0) {
      const strict = /\n\s*(references|bibliography|works cited|literature cited)\s*\n/gi;
      let s;
      while ((s = strict.exec(fullText)) !== null) headStart = s.index;
    }
    let slice = headStart >= 0 ? fullText.slice(headStart) : fullText;
    if (slice.length > 60000) slice = slice.slice(0, 60000);
    return { slice: slice.trim(), bodyEnd: headStart >= 0 ? headStart : fullText.length };
  }

  // ============================================================
  // Analyze
  // ============================================================
  const STEPS = [
    ["Extracting text", "description"],
    ["Locating references", "format_list_bulleted"],
    ["Checking CrossRef + PubMed + AI analysis", "neurology"],
    ["Building report", "summarize"],
  ];
  function renderSteps(activeIndex) {
    $("steps").innerHTML = STEPS.map((s, i) => {
      const done = i < activeIndex, active = i === activeIndex;
      const icon = done
        ? '<span class="material-symbols-outlined text-[18px] text-ok" style="font-variation-settings:\'FILL\' 1;">check_circle</span>'
        : active
        ? '<span class="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"></span>'
        : '<span class="w-4 h-4 rounded-full border border-border-subtle"></span>';
      const cls = done || active ? "text-white" : "text-ink-mute";
      return `<div class="flex items-center gap-3 ${cls}">${icon}<span class="text-sm">${s[0]}</span></div>`;
    }).join("");
  }
  function setProgress(pct) {
    $("progress-bar").style.width = pct + "%";
    $("progress-label").textContent = Math.round(pct) + "%";
  }

  analyzeBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    showView("processing");
    renderSteps(0); setProgress(8);
    try {
      // 1) extract
      const isPdf = currentFile.name.toLowerCase().endsWith(".pdf");
      const fullText = isPdf ? await extractPdf(currentFile) : await extractDocx(currentFile);
      renderSteps(1); setProgress(32);
      if (!fullText || fullText.replace(/\s/g, "").length < 40) {
        throw new Error("Couldn't read text from that file. If it's a scanned PDF, try a text-based version.");
      }
      // 2) references slice
      const { slice: referencesText, bodyEnd } = sliceReferences(fullText);
      renderSteps(2); setProgress(55);

      // 3) extract + verify — all in the browser (Gemini with your key + CrossRef/OpenAlex/etc.)
      const { data, error } = await Core.run({ filename: currentFile.name, referencesText });
      if (error) throw new Error(error.message || "Analysis failed.");
      if (data && data.error) throw new Error(data.error);
      renderSteps(3); setProgress(85);

      // 4) persist + render
      currentResult = { ...data, fullText, bodyEnd, created_at: new Date().toISOString() };
      await persist(currentResult);
      setProgress(100);
      setTimeout(() => renderResult(currentResult), 350);
      loadHistory();
    } catch (err) {
      showView("upload");
      setError(err.message || "Something went wrong. Please try again.");
    }
  });

  function persist(result) {
    result.id = result.id || newId();
    storeUpsert({
      id: result.id,
      filename: result.filename,
      integrity_score: result.integrityScore,
      counts: result.counts,
      results: refsForSave(result.references),
      citation_results: result.citationResults || {},
      feedback: result.feedback || {},
      document_text: (result.fullText || "").slice(0, 300000),
      created_at: result.created_at || new Date().toISOString(),
    });
  }

  // Persist a manual change (e.g. Flag for Review) back to the saved analysis record.
  function saveReferences() {
    if (!currentResult || !currentResult.id) return;
    storeUpsert({ id: currentResult.id, results: refsForSave(currentResult.references) });
  }

  // Toggle the manual "flag for review" bookmark on a reference.
  function toggleFlag(id) {
    if (!currentResult) return;
    const ref = (currentResult.references || []).find((r) => r.id === id);
    if (!ref) return;
    ref.marked = !ref.marked;
    saveReferences();
    renderRefs(currentResult.references);
    revealStaggers();
  }

  // ============================================================
  // Render results
  // ============================================================
  const VERDICT = {
    verified: { label: "Verified", color: "ok", icon: "check_circle" },
    review:   { label: "Review",   color: "warn", icon: "warning" },
    flagged:  { label: "Flagged",  color: "bad", icon: "cancel" },
  };

  let selectedRefId = null;     // currently spotlighted reference
  let occurrences = {};         // refId -> count of in-text marks

  function renderResult(result) {
    showView("results");
    selectedRefId = null;
    viewResults.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-visible"));
    syncPanesForViewport();
    renderVerdictBanner(result);
    $("result-filename").textContent = result.filename;
    $("result-date").textContent = new Date(result.created_at || Date.now()).toLocaleString();

    const c = result.counts, total = c.verified + c.review + c.flagged || 1;
    // natural-language summary
    const parts = [`${c.verified} of ${total} reference${total === 1 ? "" : "s"} verified`];
    if (c.flagged) parts.push(`${c.flagged} likely fabricated`);
    else if (c.review) parts.push(`${c.review} to review`);
    $("result-summary").textContent = parts.join(" · ");

    // legends + stacked bar
    $("legend-verified").textContent = c.verified;
    $("legend-review").textContent = c.review;
    $("legend-flagged").textContent = c.flagged;
    requestAnimationFrame(() => {
      $("bar-verified").style.width = (100 * c.verified / total) + "%";
      $("bar-review").style.width = (100 * c.review / total) + "%";
      $("bar-flagged").style.width = (100 * c.flagged / total) + "%";
    });

    // score ring + number
    animateCount($("score-num"), result.integrityScore);
    const ring = $("score-ring"), circ = 97.4;
    ring.style.strokeDashoffset = circ;
    requestAnimationFrame(() => {
      ring.style.transition = "stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)";
      ring.style.strokeDashoffset = (circ * (1 - result.integrityScore / 100)).toFixed(2);
    });

    // build document highlights → occurrence counts
    occurrences = renderDocument(result);

    activeFilter = "all";
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
    renderRefs(result.references);
    renderAudit(result);
    initPhase3(result);
    revealStaggers();
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    // feedback loads async; re-render the lists with thumbs state once it's here
    loadFeedback().then(() => { renderRefs(currentResult.references); renderCitations(); });
  }

  // ---- plain-language verdict for a non-specialist (teacher) ----------------
  // Translates counts + citation findings into a clear reliable / review / unreliable call.
  function teacherVerdict(result) {
    const c = result.counts || { verified: 0, review: 0, flagged: 0 };
    const total = (c.verified + c.review + c.flagged) || 0;
    let notSupported = 0, partial = 0, citChecked = 0;
    Object.values(citeResults || {}).forEach((r) => {
      if (r && r.status === "done") {
        citChecked++;
        if (r.assessment === "not_supported") notSupported++;
        if (r.assessment === "partial") partial++;
      }
    });
    const retracted = (result.references || []).filter((r) => r.retracted).length;
    const bullets = [];
    if (retracted) bullets.push(`${retracted} cited paper${retracted === 1 ? " has" : "s have"} been RETRACTED and must not be relied on as evidence`);
    if (total) bullets.push(`${c.verified} of ${total} source${total === 1 ? "" : "s"} verified as real in an academic database`);
    if (c.flagged) bullets.push(`${c.flagged} reference${c.flagged === 1 ? "" : "s"} could not be found anywhere and may be fabricated`);
    if (c.review) bullets.push(`${c.review} reference${c.review === 1 ? "" : "s"} had details that didn't fully match — worth a look`);
    if (citChecked && notSupported) bullets.push(`${notSupported} citation${notSupported === 1 ? "" : "s"} do not support the claim they're attached to`);
    if (citChecked && partial) bullets.push(`${partial} citation${partial === 1 ? "" : "s"} only partially support their claim`);

    const score = result.integrityScore ?? 0;
    const minorItems = c.review > 0 || partial > 0;
    let tier, headline, detail, icon;
    if (retracted > 0) {
      // a retracted citation is a hard problem regardless of everything else — always red
      tier = "bad"; icon = "gpp_bad";
      headline = `Unreliable — ${retracted} retracted paper${retracted === 1 ? "" : "s"} cited`;
      detail = `This manuscript cites ${retracted} paper${retracted === 1 ? " that has" : "s that have"} been formally retracted. Retracted work has been withdrawn from the literature and must not be used as evidence — locate and remove or replace ${retracted === 1 ? "it" : "them"} (see the references marked "Retracted" below)` + ((c.flagged > 0 || notSupported > 0) ? ", and also address the fabricated/misused sources flagged below." : ".");
    } else if (c.flagged > 0 || notSupported > 0) {
      // real fabrication / misused citation — always red, regardless of score
      tier = "bad"; icon = "gpp_bad";
      headline = "Unreliable — signs of fabricated or misused sources";
      detail = "Some references could not be found in any academic database, or the cited papers don't back up what the student wrote. Treat this essay's sourcing as untrustworthy until the flagged items below are checked by hand — this is a common sign of AI-generated or invented citations.";
    } else if (score >= 90) {
      // nothing fabricated AND a high reliability score -> green, even if a few items are in "review"
      tier = "ok"; icon = "verified_user";
      headline = "Looks reliable — the sources check out";
      detail = !total
        ? "No references were found in this document to check."
        : minorItems
        ? "The sourcing holds up well — nothing looks fabricated, and the vast majority of references were confirmed in an academic database. A couple of small details are worth a quick glance (see the highlighted items), but overall this is reliable."
        : "Every reference was found in a real academic database and nothing looks fabricated.";
    } else if (minorItems) {
      // moderate score with items to review -> amber
      tier = "warn"; icon = "gpp_maybe";
      headline = "Review recommended — mostly holds up, with a few things to check";
      detail = "The sources appear to be real, but several details didn't fully line up (or a citation only partially supports its claim). Worth a spot-check of the highlighted items below before relying on it.";
    } else {
      tier = "ok"; icon = "verified_user";
      headline = "Looks reliable — the sources check out";
      detail = total
        ? "Every reference was found in a real academic database and nothing looks fabricated."
        : "No references were found in this document to check.";
    }
    return { tier, headline, detail, icon, bullets, score };
  }

  function renderVerdictBanner(result) {
    const el = $("verdict-banner");
    if (!el) return;
    const v = teacherVerdict(result);
    const wrap = { ok: "bg-ok/10 border-ok/30", warn: "bg-warn/10 border-warn/30", bad: "bg-bad/10 border-bad/30" }[v.tier];
    el.className = `rounded-2xl p-5 sm:p-6 mb-5 border ${wrap}`;
    el.innerHTML = `
      <div class="flex items-start gap-4">
        <span class="material-symbols-outlined text-${v.tier} text-[34px] shrink-0" style="font-variation-settings:'FILL' 1;">${v.icon}</span>
        <div class="min-w-0 flex-grow">
          <div class="font-mono text-[10px] uppercase tracking-wider text-${v.tier} mb-1">Teacher summary</div>
          <h2 class="font-display text-lg sm:text-2xl text-white leading-tight">${escapeHtml(v.headline)}</h2>
          <p class="text-sm text-ink-soft mt-2 max-w-2xl">${escapeHtml(v.detail)}</p>
          ${v.bullets.length ? `<ul class="mt-3 flex flex-col gap-1">${v.bullets.map((b) => `<li class="text-[13px] text-ink-soft flex items-start gap-2"><span class="material-symbols-outlined text-[15px] text-${v.tier} mt-0.5">chevron_right</span>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="shrink-0 text-center hidden sm:block">
          <div class="font-display text-3xl text-white leading-none">${v.score}</div>
          <div class="font-mono text-[9px] text-ink-mute uppercase tracking-wider mt-1">reliability<br>score</div>
        </div>
      </div>`;
    el.classList.remove("hidden");
  }

  // ---- source-PDF evidence: upgrade + rescore --------------------------------
  // Same formula the backend uses: verified counts full, review counts half.
  function computeScore(counts) {
    const total = (counts.verified + counts.review + counts.flagged) || 1;
    return Math.round((100 * (counts.verified + 0.5 * counts.review)) / total);
  }

  // Uploading the actual source PDF for a reference is the strongest possible proof that the cited
  // work exists — stronger than any database lookup. So when a readable source PDF is matched to a
  // reference that CrossRef/PubMed/web could NOT confirm (i.e. it was "review" or "flagged"), we
  // reconnect it and upgrade that reference to "verified", then recompute the reliability score.
  // This is session-only: the PDF itself isn't persisted, so history keeps the honest base verdict.
  function applySourceEvidence() {
    if (!currentResult) return;
    const refs = currentResult.references || [];
    // reset per-reference source evidence (remember the backend verdict once)
    refs.forEach((r) => {
      if (r.baseVerdict == null) r.baseVerdict = r.verdict;
      r.sourceVerified = false;
      r.sourceFile = "";
    });
    // Apply the grounded, full-PDF AI verification (verifySourceMatch): only a "confirmed" verdict for
    // the CURRENTLY assigned reference upgrades it. Partial/mismatch never inflate the score.
    sourcePapers.forEach((p) => {
      if (p.refId == null || !p.text || p.error) return;
      const r = refs.find((x) => x.id === p.refId);
      if (!r) return;
      const ai = p.aiMatch;
      if (ai && ai.status === "done" && ai.refId === p.refId && ai.verdict === "confirmed") {
        r.sourceVerified = true; r.sourceFile = p.filename;
      }
    });
    // apply: a confirmed source PDF proves the reference is REAL — but identity-confirmed is NOT the
    // same as correctly-cited. If the claim(s) that cite this reference are NOT supported by the very
    // PDF that proves it real, the citation is being MISUSED, so we flag it instead of calling it a
    // clean "verified". (This is the fix for a red "Not supported by the source" card that still said
    // the reference was "verified" at the bottom.)
    refs.forEach((r) => {
      r.claimMisuse = false; r.claimOverstated = false;
      if (r.sourceVerified) {
        // a confirmed source PDF governs (accuracy layer), even over a manual approval
        const assess = citationInstances
          .filter((inst) => inst.refId === r.id)
          .map((inst) => citeResults[inst.id])
          .filter((x) => x && x.status === "done")
          .map((x) => x.assessment);
        if (assess.includes("not_supported")) { r.claimMisuse = true; r.verdict = "flagged"; return; }
        if (assess.includes("partial")) { r.claimOverstated = true; r.verdict = "review"; return; }
        r.verdict = "verified"; return;
      }
      // no source PDF: a manual approval (user override — e.g. a paywalled but clearly-correct link)
      // wins over the existence verdict, unless the work is retracted.
      if (r.manualApproved && !r.retracted) { r.verdict = "verified"; return; }
      r.verdict = r.baseVerdict;
    });
    currentResult.counts = {
      verified: refs.filter((r) => r.verdict === "verified").length,
      review: refs.filter((r) => r.verdict === "review").length,
      flagged: refs.filter((r) => r.verdict === "flagged").length,
    };
    currentResult.integrityScore = computeScore(currentResult.counts);
  }

  // Repaint everything that depends on verdicts/score after source evidence changes.
  function refreshScoreUI() {
    const result = currentResult;
    if (!result) return;
    const c = result.counts, total = (c.verified + c.review + c.flagged) || 1;
    const parts = [`${c.verified} of ${total} reference${total === 1 ? "" : "s"} verified`];
    if (c.flagged) parts.push(`${c.flagged} likely fabricated`);
    else if (c.review) parts.push(`${c.review} to review`);
    $("result-summary").textContent = parts.join(" · ");
    $("legend-verified").textContent = c.verified;
    $("legend-review").textContent = c.review;
    $("legend-flagged").textContent = c.flagged;
    $("bar-verified").style.width = (100 * c.verified / total) + "%";
    $("bar-review").style.width = (100 * c.review / total) + "%";
    $("bar-flagged").style.width = (100 * c.flagged / total) + "%";
    $("score-num").textContent = result.integrityScore;
    const ring = $("score-ring"), circ = 97.4;
    ring.style.strokeDashoffset = (circ * (1 - result.integrityScore / 100)).toFixed(2);
    renderVerdictBanner(result);
    occurrences = renderDocument(result); // verdict colors on in-text highlights
    renderRefs(result.references);
    renderAudit(result);
  }

  // Called whenever source PDFs are added / matched / reassigned / removed.
  function syncSourceEvidence() {
    applySourceEvidence();
    renderSources();       // reflect the recheck result (confirmed / mismatch) on each PDF
    refreshScoreUI();
    renderCitations();
    updateCiteSummary();
    checkClaimsForConfirmedSources(); // fire-and-forget: fill confirmed PDFs with claim-vs-source evidence
  }

  // Strip session-only source upgrades before persisting, so the saved analysis keeps the honest
  // backend verdicts (history won't claim "verified" when the PDF is no longer attached).
  function refsForSave(refs) {
    return (refs || []).map((r) => {
      const clean = { ...r };
      // revert session-only source-PDF upgrades to the honest base verdict...
      if (r.sourceVerified && r.baseVerdict != null) clean.verdict = r.baseVerdict;
      // ...but KEEP a manual approval (a deliberate user decision) so it survives reload.
      if (r.manualApproved && !r.retracted && !(r.sourceVerified && r.claimMisuse)) clean.verdict = "verified";
      delete clean.baseVerdict; delete clean.sourceVerified; delete clean.sourceFile;
      delete clean.claimMisuse; delete clean.claimOverstated;
      return clean;
    });
  }
  // Manual override: mark a review/flagged reference as verified (e.g. the cited work is real and the
  // link is right, but it's paywalled so the checker couldn't open it). Toggles on/off.
  function manualApprove(id) {
    if (!currentResult) return;
    const ref = (currentResult.references || []).find((r) => r.id === id);
    if (!ref) return;
    if (ref.baseVerdict == null) ref.baseVerdict = ref.verdict;
    ref.manualApproved = !ref.manualApproved;
    applySourceEvidence();
    refreshScoreUI();
    saveReferences();
  }

  // ---- document highlighter -------------------------------------------------
  function inferStyle(result) {
    if (result.citationStyle && result.citationStyle !== "unknown") return result.citationStyle;
    const markers = (result.references || []).map((r) => r.marker || "");
    const numeric = markers.filter((m) => /^\d+$/.test(m.trim())).length;
    return numeric >= markers.length / 2 ? "numbered" : "author-year";
  }

  // Compute every in-text citation range {start, end, refId} in the body (unmerged —
  // a group like [1,2] yields one range per referenced id). Shared by the highlighter
  // and the Phase-3 claim extractor so they always agree.
  function computeCitationRanges(result, body) {
    const style = inferStyle(result);
    const ranges = [];
    if (style === "numbered") {
      const byNum = {};
      (result.references || []).forEach((r) => {
        const n = (r.marker || "").trim();
        if (/^\d+$/.test(n)) byNum[n] = r.id;
      });
      // bracketed / parenthesised digit groups: [1], (1), [1,2], [1-3]
      const re = /[\[(]\s*(\d{1,3}(?:\s*[–—-]\s*\d{1,3}|\s*,\s*\d{1,3})*)\s*[\])]/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        const nums = expandNumberGroup(m[1]);
        nums.forEach((n) => { if (byNum[n] != null) ranges.push({ start: m.index, end: m.index + m[0].length, refId: byNum[n] }); });
      }
    } else {
      // author-year: first-author surname within ~40 chars of its year.
      // NOTE: the gap must allow periods — otherwise the "." in "et al." blocks the match, so
      // "Smith et al. (2020)" / "Garcia et al., 2021" (the overwhelmingly common forms) were all
      // missed and never reached the citation-accuracy check. Only a bare "Surname 2020" matched.
      // Cap + non-greedy keeps it to the nearest year so it stays local to the citation.
      (result.references || []).forEach((r) => {
        const surname = firstSurname(r.authors) || firstSurname(r.marker);
        const year = (String(r.year).match(/\d{4}/) || (r.marker || "").match(/\d{4}/) || [])[0];
        if (!surname || !year) return;
        const re = new RegExp(escapeRe(surname) + "[^\\n]{0,40}?" + year, "g");
        let m;
        while ((m = re.exec(body)) !== null) {
          ranges.push({ start: m.index, end: m.index + m[0].length, refId: r.id });
          if (re.lastIndex === m.index) re.lastIndex++;
        }
      });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return ranges;
  }

  function docBody(result) {
    return (result.fullText || "").slice(0, result.bodyEnd || (result.fullText || "").length);
  }

  // returns map refId -> occurrence count, and paints #doc-text
  function renderDocument(result) {
    const docEl = $("doc-text");
    const counts = {};
    (result.references || []).forEach((r) => (counts[r.id] = 0));
    const body = docBody(result);

    if (!body.trim()) {
      docEl.innerHTML = '<p class="text-ink-mute text-sm">Document text isn\'t available for this analysis.</p>';
      $("doc-cite-count").textContent = "";
      return counts;
    }

    const verdictOf = {};
    (result.references || []).forEach((r) => (verdictOf[r.id] = r.verdict));
    const ranges = computeCitationRanges(result, body);

    // merge overlaps (keep earliest); build HTML
    let html = "", cursor = 0, lastEnd = -1;
    for (const rg of ranges) {
      if (rg.start < lastEnd) continue; // skip overlaps
      counts[rg.refId] = (counts[rg.refId] || 0) + 1;
      html += escapeHtml(body.slice(cursor, rg.start));
      const vClass = { verified: "v-ok", review: "v-warn", flagged: "v-bad" }[verdictOf[rg.refId]] || "v-warn";
      html += `<mark class="cite ${vClass}" data-ref-id="${rg.refId}">${escapeHtml(body.slice(rg.start, rg.end))}</mark>`;
      cursor = rg.end; lastEnd = rg.end;
    }
    html += escapeHtml(body.slice(cursor));
    docEl.innerHTML = html;

    const totalMarks = ranges.length;
    $("doc-cite-count").textContent = totalMarks ? `· ${totalMarks} citation${totalMarks === 1 ? "" : "s"} found` : "· no in-text citations detected";

    docEl.querySelectorAll("mark.cite").forEach((mk) => {
      mk.addEventListener("click", () => selectRef(parseInt(mk.dataset.refId, 10), { fromDoc: true }));
    });
    return counts;
  }

  // ---- citation audit: retractions + dangling in-text citations ----
  // (Bibliography entries that are never cited in the body are intentionally NOT flagged.)
  // In-text citation NUMBERS present in the body that map to no reference in the list. Reliable for
  // numbered styles; author-year in-text markers are too noisy to assert, so we skip them there.
  function findDanglingCitations(result, body) {
    if (inferStyle(result) !== "numbered") return [];
    const refNums = new Set();
    (result.references || []).forEach((r) => { const num = (r.marker || "").trim(); if (/^\d+$/.test(num)) refNums.add(num); });
    const cited = new Set();
    const re = /[\[(]\s*(\d{1,3}(?:\s*[–—-]\s*\d{1,3}|\s*,\s*\d{1,3})*)\s*[\])]/g;
    let m;
    while ((m = re.exec(body)) !== null) expandNumberGroup(m[1]).forEach((n) => cited.add(n));
    return [...cited].filter((n) => !refNums.has(n)).sort((a, b) => (+a) - (+b));
  }

  function renderAudit(result) {
    const el = $("audit-panel");
    if (!el) return;
    const refs = result.references || [];
    const body = docBody(result);
    const hasBody = !!body.trim();

    const retracted = refs.filter((r) => r.retracted);
    // Only assert dangling findings when the highlighter actually resolved SOME citations — otherwise a
    // style the matcher couldn't parse would falsely mark every cited number as dangling.
    const anyCited = hasBody && refs.some((r) => occurrences[r.id] > 0);
    // dangling in-text citations: cited in the body but absent from the reference list (numbered only)
    const dangling = anyCited ? findDanglingCitations(result, body) : [];

    if (!retracted.length && !dangling.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }

    const chip = (id, label) => `<button class="audit-jump inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.04] border border-border-subtle text-[11px] text-ink-soft hover:text-ink hover:border-border-strong transition-colors" data-ref-id="${id}">[${escapeHtml(String(label))}]</button>`;
    const plainChip = (label) => `<span class="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.04] border border-border-subtle text-[11px] text-ink-soft">[${escapeHtml(String(label))}]</span>`;

    const sections = [];
    if (retracted.length) {
      sections.push(`<div>
        <div class="flex items-center gap-1.5 text-bad text-[12px] font-semibold mb-1.5"><span class="material-symbols-outlined text-[15px]" style="font-variation-settings:'FILL' 1;">block</span>${retracted.length} retracted paper${retracted.length === 1 ? "" : "s"} cited</div>
        <p class="text-[12px] text-ink-soft mb-2">Real publications that were formally <b>retracted</b> — remove or replace them; don't cite as evidence.</p>
        <div class="flex flex-wrap gap-1.5">${retracted.map((r) => chip(r.id, r.marker || r.id)).join("")}</div>
      </div>`);
    }
    if (dangling.length) {
      sections.push(`<div>
        <div class="flex items-center gap-1.5 text-warn text-[12px] font-semibold mb-1.5"><span class="material-symbols-outlined text-[15px]">rule</span>${dangling.length} in-text citation${dangling.length === 1 ? "" : "s"} with no matching reference</div>
        <p class="text-[12px] text-ink-soft mb-2">Cited in the body but missing from the reference list — a numbering gap or a dropped entry.</p>
        <div class="flex flex-wrap gap-1.5">${dangling.map((n) => plainChip(n)).join("")}</div>
      </div>`);
    }

    el.className = "mb-5 rounded-2xl border border-border-subtle glass p-5";
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-3">
        <span class="material-symbols-outlined text-ink-soft text-[18px]">fact_check</span>
        <h3 class="font-display text-base text-white">Citation audit</h3>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${sections.join("")}</div>`;
    el.querySelectorAll(".audit-jump").forEach((b) => b.addEventListener("click", () => selectRef(parseInt(b.dataset.refId, 10), { fromDoc: true })));
    el.classList.remove("hidden");
  }

  function expandNumberGroup(s) {
    const out = [];
    s.split(",").forEach((part) => {
      const r = part.trim().match(/^(\d{1,3})\s*[–—-]\s*(\d{1,3})$/);
      if (r) { for (let i = +r[1]; i <= +r[2] && i - +r[1] < 60; i++) out.push(String(i)); }
      else if (/^\d{1,3}$/.test(part.trim())) out.push(part.trim());
    });
    return out;
  }
  function firstSurname(s) {
    if (!s) return "";
    const tok = String(s).replace(/^[\s,;]+/, "").split(/[,;&]| and | et al\.?/i)[0].trim();
    const words = tok.split(/\s+/).filter(Boolean);
    // surname is usually the last capitalised word of the first author token
    const cand = words.reverse().find((w) => /^[A-Z][a-zA-Z'’-]{1,}$/.test(w));
    return cand || "";
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // ---- reference cards ------------------------------------------------------
  function renderRefs(refs) {
    const list = $("ref-list");
    const shown = activeFilter === "all" ? refs
      : activeFilter === "marked" ? refs.filter((r) => r.marked)
      : refs.filter((r) => r.verdict === activeFilter);
    if (!shown.length) {
      const msg = activeFilter === "marked"
        ? "Nothing flagged yet. Use the bookmark on a reference to mark it for review."
        : "No references in this category.";
      list.innerHTML = `<p class="text-sm text-ink-mute text-center py-10">${msg}</p>`;
      return;
    }
    list.innerHTML = shown.map((r) => {
      const v = VERDICT[r.verdict] || VERDICT.review;
      const retracted = !!r.retracted;
      const retractedPill = retracted
        ? `<span class="font-mono text-[10px] uppercase px-2 py-0.5 rounded-full bg-bad text-white border border-bad inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]" style="font-variation-settings:'FILL' 1;">block</span>Retracted</span>` : "";
      const retractedAlert = retracted
        ? `<p class="text-[12px] text-bad font-semibold mt-2 flex items-start gap-1.5"><span class="material-symbols-outlined text-[15px] shrink-0" style="font-variation-settings:'FILL' 1;">block</span>This paper has been retracted — do not cite it as valid evidence.</p>` : "";
      const meta = [r.authors, [r.journal, r.year].filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
      const n = occurrences[r.id] || 0;
      const cited = n > 0
        ? `<button class="ref-jump inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" data-ref-id="${r.id}"><span class="material-symbols-outlined text-[14px]">my_location</span>Cited ${n}×</button>`
        : `<span class="inline-flex items-center gap-1 text-[11px] text-ink-mute"><span class="material-symbols-outlined text-[14px]">location_off</span>Not found in text</span>`;
      const srcLabel = { pubmed: "PubMed", web: "the web", openalex: "OpenAlex", datacite: "DataCite", googlebooks: "Google Books" }[r.source] || "CrossRef";
      // when not confirmed, tailor the label for web/news references (a dead or unmatched link)
      const webNeg = { dead: "Cited link is dead", "live-nomatch": "Link doesn't match", blocked: "Link couldn't be checked", unreachable: "Link unreachable" }[r.webStatus] || "";
      const exists = r.sourceVerified
        ? `<span class="inline-flex items-center gap-1 text-[11px] text-ok"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">upload_file</span>Verified via your source PDF</span>`
        : r.exists
        ? (r.source === "web"
            ? `<span class="inline-flex items-center gap-1 text-[11px] text-ok"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">public</span>Live web source</span>`
            : `<span class="inline-flex items-center gap-1 text-[11px] text-ok"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">check_circle</span>Found in ${srcLabel}</span>`)
        : `<span class="inline-flex items-center gap-1 text-[11px] text-ink-mute"><span class="material-symbols-outlined text-[14px]">${webNeg ? "link_off" : "help"}</span>${webNeg || "Not found in any database"}</span>`;
      const link = r.crossrefUrl
        ? `<a href="${r.crossrefUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[14px]">link</span>${escapeHtml(r.doi || "DOI")}</a>`
        : "";
      const pmLink = r.pubmedUrl
        ? `<a href="${r.pubmedUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[14px]">open_in_new</span>PMID ${escapeHtml(r.pmid || "")}</a>`
        : "";
      const webLink = (r.webUrl || r.url)
        ? `<a href="${escapeHtml(r.webUrl || r.url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[14px]">open_in_new</span>Open link</a>`
        : "";
      // match details: database title vs. the manuscript's title (why it was / wasn't flagged)
      const showMatch = r.matchedTitle && r.matchedTitle.toLowerCase() !== (r.title || "").toLowerCase();
      const matched = showMatch
        ? `<div class="text-[11px] mt-1.5 rounded-md bg-white/[0.02] border border-border-subtle px-2.5 py-1.5">
             <p class="text-ink-mute"><span class="text-ink-soft">${r.source === "web" ? (r.exists ? "Live page title" : "Page at cited link") : (r.exists ? srcLabel + " record" : "Closest DB match")}:</span> ${escapeHtml(r.matchedTitle)}</p>
             ${r.title ? `<p class="text-ink-mute mt-0.5"><span class="text-ink-soft">Your manuscript:</span> ${escapeHtml(r.title)}</p>` : ""}
           </div>` : "";
      // when a source PDF verified this reference, fold in the grounded, quoted explanation from the
      // full-PDF AI check (the same reasoning shown in the Sources panel).
      const srcPaper = r.sourceVerified ? sourcePapers.find((p) => p.refId === r.id && p.aiMatch && p.aiMatch.refId === r.id && p.aiMatch.status === "done" && p.aiMatch.verdict === "confirmed") : null;
      const ai = srcPaper && srcPaper.aiMatch;
      const evidenceSentence = ai && ai.explanation ? ai.explanation + " " : "";
      const reasonText = (r.sourceVerified && r.baseVerdict && r.baseVerdict !== "verified")
        ? `You uploaded the source PDF for this reference${r.sourceFile ? ` (${r.sourceFile})` : ""}, which confirms the cited work exists — it was previously "${(VERDICT[r.baseVerdict] || VERDICT.review).label}" because it couldn't be found in a database, and is now counted as verified. ${evidenceSentence}` + (r.reason || "")
        : (r.reason || "");
      const conf = typeof r.confidence === "number"
        ? `<div class="flex items-center gap-2 mt-2.5"><span class="font-mono text-[9px] text-ink-mute uppercase">conf</span><div class="conf-bar w-16 h-1 rounded-full bg-white/8 overflow-hidden"><span class="bg-${v.color}" style="width:${Math.round(r.confidence * 100)}%"></span></div></div>` : "";
      // Manual approve: shown on review/flagged refs (e.g. a real, correctly-linked but paywalled source
      // the checker couldn't open). Not offered for retracted work.
      const canApprove = !r.retracted && (r.verdict === "review" || r.verdict === "flagged" || r.manualApproved);
      const approveBtn = canApprove
        ? `<button class="ref-approve mt-2.5 inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md border transition-colors ${r.manualApproved ? "border-ok/40 text-ok bg-ok/10" : "border-border-strong text-ink-soft hover:text-ink hover:border-border-strong"}" data-ref-id="${r.id}" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[14px]" ${r.manualApproved ? "style=\"font-variation-settings:'FILL' 1;\"" : ""}>${r.manualApproved ? "check_circle" : "task_alt"}</span>${r.manualApproved ? "Approved by you — undo" : "Manually approve"}</button>`
        : "";
      const flagBtn = `<button class="ref-flag shrink-0 p-1 -m-1 rounded ${r.marked ? "text-warn" : "text-ink-mute hover:text-ink"} transition-colors" data-ref-id="${r.id}" title="${r.marked ? "Unflag" : "Flag for review"}" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[18px]" style="${r.marked ? "font-variation-settings:'FILL' 1;" : ""}">${r.marked ? "bookmark" : "bookmark_border"}</span></button>`;
      return `
      <div class="ref-card glass beam lift rounded-xl p-4${r.marked ? " is-marked" : ""}" data-ref-id="${r.id}" role="button" tabindex="0">
        <div class="flex gap-3 items-start">
          <span class="material-symbols-outlined text-${v.color} text-[20px] mt-0.5 shrink-0" style="font-variation-settings:'FILL' 1;">${v.icon}</span>
          <div class="min-w-0 flex-grow">
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm text-white leading-snug">${escapeHtml(r.title || r.raw)}</p>
              <div class="flex items-center gap-1.5 shrink-0">
                ${flagBtn}
                ${retractedPill}
                <span class="font-mono text-[10px] uppercase px-2 py-0.5 rounded-full bg-${v.color}/10 text-${v.color} border border-${v.color}/20">${v.label}</span>
              </div>
            </div>
            ${meta ? `<p class="font-mono text-[11px] text-ink-mute mt-1">${escapeHtml(meta)}</p>` : ""}
            ${retractedAlert}
            ${matched}
            <p class="text-[12.5px] text-ink-soft mt-2 leading-relaxed">${escapeHtml(reasonText)}</p>
            ${conf}
            <div class="flex items-center gap-4 mt-2.5 flex-wrap">${cited}${exists}${link}${pmLink}${webLink}</div>
            ${approveBtn}
            ${currentResult && currentResult.id ? feedbackBlock("reference", String(r.id)) : ""}
          </div>
        </div>
      </div>`;
    }).join("");

    // wire card interactions
    list.querySelectorAll(".ref-card").forEach((card) => {
      const id = parseInt(card.dataset.refId, 10);
      card.addEventListener("click", () => selectRef(id, {}));
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRef(id, {}); } });
    });
    list.querySelectorAll(".ref-jump").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); selectRef(parseInt(b.dataset.refId, 10), { scrollDoc: true });
    }));
    list.querySelectorAll(".ref-flag").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); toggleFlag(parseInt(b.dataset.refId, 10));
    }));
    list.querySelectorAll(".ref-approve").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); manualApprove(parseInt(b.dataset.refId, 10));
    }));
    wireFeedback(list);
    attachBeam(list.querySelectorAll(".beam"));
    if (selectedRefId != null) applySelection();
  }

  // ---- linked selection -----------------------------------------------------
  function selectRef(id, opts) {
    selectedRefId = selectedRefId === id && !opts.fromDoc && !opts.scrollDoc ? null : id;
    applySelection(true, opts);
  }
  function applySelection(scroll, opts) {
    opts = opts || {};
    const docEl = $("doc-text");
    const marks = docEl.querySelectorAll("mark.cite");
    marks.forEach((mk) => {
      const on = selectedRefId != null && parseInt(mk.dataset.refId, 10) === selectedRefId;
      mk.classList.toggle("selected", on);
      mk.classList.toggle("dim", selectedRefId != null && !on);
    });
    document.querySelectorAll(".ref-card").forEach((c) =>
      c.classList.toggle("selected", selectedRefId != null && parseInt(c.dataset.refId, 10) === selectedRefId));

    if (scroll && selectedRefId != null) {
      const mobile = window.innerWidth < 1024;
      if (opts.fromDoc) {
        if (mobile) switchPane("refs");
        const card = document.querySelector(`.ref-card[data-ref-id="${selectedRefId}"]`);
        if (card) card.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      } else {
        if (mobile) switchPane("doc");
        const firstMark = docEl.querySelector(`mark.cite[data-ref-id="${selectedRefId}"]`);
        if (firstMark) firstMark.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      }
    }
  }
  function switchPane(pane) {
    document.querySelectorAll("[data-pane]").forEach((b) => b.classList.toggle("active", b.dataset.pane === pane));
    $("pane-doc").classList.toggle("hidden", pane !== "doc");
    $("pane-refs").classList.toggle("hidden", pane !== "refs");
  }

  // highlight on/off toggle
  $("hl-toggle").addEventListener("click", () => {
    $("doc-text").classList.toggle("hl-off");
    $("hl-toggle").classList.toggle("text-white");
  });

  // mobile pane tabs
  document.querySelectorAll("[data-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pane = btn.dataset.pane;
      document.querySelectorAll("[data-pane]").forEach((b) => b.classList.toggle("active", b === btn));
      $("pane-doc").classList.toggle("hidden", pane !== "doc");
      $("pane-refs").classList.toggle("hidden", pane !== "refs");
    });
  });
  function syncPanesForViewport() {
    if (window.innerWidth >= 1024) { $("pane-doc").classList.remove("hidden"); $("pane-refs").classList.remove("hidden"); }
    else {
      const active = document.querySelector("[data-pane].active");
      const pane = active ? active.dataset.pane : "doc";
      $("pane-doc").classList.toggle("hidden", pane !== "doc");
      $("pane-refs").classList.toggle("hidden", pane !== "refs");
    }
  }
  window.addEventListener("resize", syncPanesForViewport);

  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
      if (currentResult) { renderRefs(currentResult.references); revealStaggers(); }
    });
  });

  // ---- export helpers -------------------------------------------------------
  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function baseName() { return (currentResult.filename || "report").replace(/\.[^.]+$/, ""); }
  function statusText(r) {
    const label = (VERDICT[r.verdict] || VERDICT.review).label;
    const where = r.exists ? ` (found in ${r.source === "pubmed" ? "PubMed" : "CrossRef"})` : " (not found)";
    return label + where + (r.marked ? " · flagged for review" : "");
  }

  // export CSV — Ref #, Authors, Title, Journal, Year, DOI, Status, Found In, Cited, Reason, Full Text
  $("export-btn").addEventListener("click", () => {
    if (!currentResult) return;
    const header = ["Reference Number", "Authors", "Title", "Journal", "Year", "DOI",
      "Status", "Found In", "Cited In Text", "AI Reason", "Full Text"];
    const rows = [header];
    currentResult.references.forEach((r, i) =>
      rows.push([
        i + 1, r.authors, r.title, r.journal, r.year, r.doi,
        statusText(r),
        r.exists ? (r.source === "pubmed" ? "PubMed" : "CrossRef") : "—",
        occurrences[r.id] || 0, r.reason, r.raw,
      ]));
    const csv = rows.map((row) => row.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    download(baseName() + "_refcheck.csv", "text/csv;charset=utf-8", "﻿" + csv);
  });

  // export full verification report — a Word-openable .doc (HTML)
  $("report-btn").addEventListener("click", () => {
    if (!currentResult) return;
    const c = currentResult.counts, total = (c.verified + c.review + c.flagged) || 1;
    const COLOR = { verified: "#1a7f4b", review: "#b07d12", flagged: "#b03a4a" };
    const when = new Date(currentResult.created_at || Date.now()).toLocaleString();
    const rowsHtml = currentResult.references.map((r, i) => {
      const v = (VERDICT[r.verdict] || VERDICT.review).label;
      const col = COLOR[r.verdict] || COLOR.review;
      const found = r.exists ? (r.source === "pubmed" ? "PubMed" : "CrossRef") : "Not found";
      const ident = r.doi ? `DOI: ${escapeHtml(r.doi)}` : (r.pmid ? `PMID: ${escapeHtml(r.pmid)}` : "");
      return `<tr>
        <td style="text-align:center">${i + 1}</td>
        <td><b>${escapeHtml(r.title || r.raw)}</b>${r.authors ? `<br><span style="color:#555">${escapeHtml(r.authors)}</span>` : ""}
            ${[r.journal, r.year].filter(Boolean).map(escapeHtml).join(" &middot; ")}${ident ? `<br><span style="color:#777;font-size:10px">${ident}</span>` : ""}</td>
        <td style="color:${col};font-weight:bold;white-space:nowrap">${v}${r.marked ? " &#9733;" : ""}</td>
        <td>${found}</td>
        <td style="color:#444">${escapeHtml(r.reason || "")}</td>
      </tr>`;
    }).join("");
    const v = teacherVerdict(currentResult);
    const vColor = { ok: "#1a7f4b", warn: "#b07d12", bad: "#b03a4a" }[v.tier];
    const verdictHtml = `<div style="border-left:5px solid ${vColor};background:#f7f7f9;padding:12px 16px;margin:14px 0">
        <div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#777">Teacher summary</div>
        <div style="font-size:17px;font-weight:bold;color:${vColor};margin:2px 0">${escapeHtml(v.headline)}</div>
        <div style="font-size:13px;color:#333">${escapeHtml(v.detail)}</div>
        ${v.bullets.length ? `<ul style="font-size:13px;color:#333;margin:8px 0 0">${v.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
      </div>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Source Reliability Report</title></head>
      <body style="font-family:Calibri,Arial,sans-serif;color:#1a1a1a">
        <h1 style="margin-bottom:2px">REF/CHECK — Source Reliability Report</h1>
        <p style="color:#666;margin-top:0">${escapeHtml(currentResult.filename || "manuscript")} &middot; ${when}</p>
        ${verdictHtml}
        <p style="font-size:15px"><b>Reliability score: ${currentResult.integrityScore}/100.</b>
           ${c.verified} verified, ${c.review} to review, ${c.flagged} flagged
           (of ${total} reference${total === 1 ? "" : "s"}).</p>
        <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:12px;border-color:#ccc">
          <thead><tr style="background:#f0f0f3">
            <th>#</th><th style="text-align:left">Reference</th><th>Status</th><th>Found In</th><th style="text-align:left">Assessment</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p style="color:#888;font-size:11px;margin-top:16px">Generated by REF/CHECK AI. Existence verified against CrossRef and PubMed;
          plausibility assessed by AI. This is a screening tool — confirm flagged items manually.</p>
      </body></html>`;
    download(baseName() + "_refcheck_report.doc", "application/msword", html);
  });

  // ============================================================
  // History
  // ============================================================
  function loadHistory() {
    const data = loadStore();
    if (historyCount) historyCount.textContent = data.length;
    const clearBtn = $("history-clear");
    if (clearBtn) clearBtn.classList.toggle("hidden", !data.length);
    historyList.querySelectorAll("[data-hid]").forEach((n) => n.remove());
    if (!data.length) { historyEmpty.classList.remove("hidden"); return; }
    historyEmpty.classList.add("hidden");
    data.forEach((row) => {
      // Wrapper (not a <button>) so the delete control can be a real, separate button — a button
      // nested inside a button is invalid HTML and swallows clicks.
      const el = document.createElement("div");
      el.setAttribute("data-hid", row.id);
      el.className = "group relative rounded-lg border border-border-subtle hover:border-border-strong hover:bg-white/[0.03] transition-colors";
      el.innerHTML = `
        <button class="hist-open text-left w-full rounded-lg px-3 py-2.5 pr-9">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[16px] text-ink-mute shrink-0">description</span>
            <span class="text-xs text-white truncate flex-grow">${escapeHtml(row.filename)}</span>
            <span class="font-mono text-[11px] text-ink-soft shrink-0">${row.integrity_score}</span>
          </div>
          <div class="font-mono text-[10px] text-ink-mute mt-1">${new Date(row.created_at).toLocaleDateString()} · ${row.counts.flagged} flagged</div>
        </button>
        <button class="hist-del absolute top-1.5 right-1.5 w-6 h-6 rounded-md flex items-center justify-center text-ink-mute hover:text-bad hover:bg-bad/10 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 transition-opacity" title="Delete this analysis" aria-label="Delete analysis">
          <span class="material-symbols-outlined text-[15px]">delete</span>
        </button>`;
      el.querySelector(".hist-open").addEventListener("click", () => {
        const fullText = row.document_text || "";
        const { bodyEnd } = fullText ? sliceReferences(fullText) : { bodyEnd: 0 };
        currentResult = {
          id: row.id,
          filename: row.filename, integrityScore: row.integrity_score,
          counts: row.counts, references: row.results, created_at: row.created_at,
          citationResults: row.citation_results || {},
          feedback: row.feedback || {},
          fullText, bodyEnd,
        };
        renderResult(currentResult);
        closeSidebar();
      });
      el.querySelector(".hist-del").addEventListener("click", (e) => { e.stopPropagation(); deleteHistory(row.id); });
      historyList.appendChild(el);
    });
  }

  // Delete one saved analysis (with confirmation). If it's the one on screen, return to upload.
  function deleteHistory(id) {
    const rec = storeGet(id);
    const name = rec ? rec.filename : "this analysis";
    if (!confirm(`Delete "${name}" from your history? This can't be undone.`)) return;
    saveStore(loadStore().filter((r) => r.id !== id));
    if (currentResult && currentResult.id === id) { currentResult = null; showView("upload"); }
    loadHistory();
  }
  // Delete the entire history at once (with confirmation).
  function clearAllHistory() {
    const n = loadStore().length;
    if (!n) return;
    if (!confirm(`Delete all ${n} saved ${n === 1 ? "analysis" : "analyses"}? This can't be undone.`)) return;
    saveStore([]);
    currentResult = null; showView("upload");
    loadHistory();
  }

  $("new-analysis-btn").addEventListener("click", () => {
    currentFile = null; fileInput.value = "";
    fileSelected.classList.add("hidden"); analyzeBtn.disabled = true; setError("");
    clearBatch();
    showView("upload"); closeSidebar();
  });

  { const hc = $("history-clear"); if (hc) hc.addEventListener("click", clearAllHistory); }

  $("batch-start").addEventListener("click", processBatch);

  // ============================================================
  // Views + sidebar
  // ============================================================
  function showView(name) {
    viewUpload.classList.toggle("hidden", name !== "upload");
    viewProcessing.classList.toggle("hidden", name !== "processing");
    viewResults.classList.toggle("hidden", name !== "results");
  }

  const sidebar = $("sidebar"), backdrop = $("sidebar-backdrop");
  function openSidebar() {
    sidebar.classList.remove("hidden"); sidebar.classList.add("flex", "fixed", "z-40", "top-16", "bottom-0", "left-0", "bg-bg");
    backdrop.classList.remove("hidden");
  }
  function closeSidebar() {
    if (window.innerWidth < 1024) {
      sidebar.classList.add("hidden"); sidebar.classList.remove("fixed", "z-40", "top-16", "bottom-0", "left-0", "bg-bg");
      backdrop.classList.add("hidden");
    }
  }
  $("sidebar-toggle").addEventListener("click", () =>
    sidebar.classList.contains("hidden") ? openSidebar() : closeSidebar());
  backdrop.addEventListener("click", closeSidebar);

  // ============================================================
  // Animations: count-up, reveal, beam glow + tilt
  // ============================================================
  function animateCount(el, target) {
    if (reduceMotion) { el.textContent = target; return; }
    const dur = 900, start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function revealStaggers() {
    document.querySelectorAll("[data-stagger]").forEach((el) => {
      el.classList.remove("is-visible");
      Array.from(el.children).forEach((c, i) => (c.style.transitionDelay = i * 45 + "ms"));
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
    });
  }

  function attachBeam(nodes) {
    nodes.forEach((card) => {
      if (card.__beam) return;
      card.__beam = true;
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        card.style.setProperty("--x", x.toFixed(1));
        card.style.setProperty("--y", y.toFixed(1));
        card.style.setProperty("--xp", (x / r.width).toFixed(3));
        if (!reduceMotion && card.classList.contains("lift")) {
          const ry = ((x - r.width / 2) / (r.width / 2)) * 4;
          const rx = ((y - r.height / 2) / (r.height / 2)) * -4;
          card.style.transition = "transform 0.1s ease-out";
          card.style.transform = `perspective(1000px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-3px)`;
        }
      }, { passive: true });
      card.addEventListener("pointerleave", () => {
        card.style.transition = "transform 0.5s ease";
        card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg)";
      });
    });
  }

  function initInteractions() {
    // reveal on load
    const io = ("IntersectionObserver" in window && !reduceMotion)
      ? new IntersectionObserver((entries) => entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
        }), { threshold: 0.12 })
      : null;
    document.querySelectorAll("[data-reveal]").forEach((el) => io ? io.observe(el) : el.classList.add("is-visible"));
    attachBeam(document.querySelectorAll(".beam"));
  }

  // ============================================================
  // Phase 3 — source papers + AI citation checking
  // ============================================================
  const ASSESS = {
    supported:     { label: "Supported by the source", color: "ok", icon: "check_circle" },
    partial:       { label: "Overstated / partially supported", color: "warn", icon: "remove_circle" },
    not_supported: { label: "Not supported by the source", color: "bad", icon: "cancel" },
    unclear:       { label: "Can't tell from the source", color: "ink-mute", icon: "help" },
  };
  function refById(id) { return (currentResult.references || []).find((r) => r.id === id); }
  function tokenize(s) { return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2); }

  function initPhase3(result) {
    sourcePapers = [];
    citeResults = (result.citationResults && typeof result.citationResults === "object") ? { ...result.citationResults } : {};
    buildCitationInstances(result);
    renderSources();
    renderCitations();
    updateCiteSummary();
    // reset + render the evidence table for this analysis
    evidenceRunning = false; evidenceStopFlag = false;
    const ep = $("evidence-progress"); if (ep) ep.classList.add("hidden");
    const er = $("evidence-run"); if (er) er.classList.remove("hidden");
    const es = $("evidence-stop"); if (es) es.classList.add("hidden");
    renderEvidenceTable(); renderEvidenceSummary();
    const cpw = $("cite-progress-wrap"); if (cpw) cpw.classList.add("hidden");
    const fr = $("format-result"); fr.classList.add("hidden"); fr.innerHTML = "";
  }

  // ---- Phase 5C: reference format consistency ----
  // Decide a single reference's style using every signal we have — the citation MARKER (numeric for
  // numbered style; "Surname Year" for author-year), plus the raw string. Returns "numbered",
  // "author-year", or "other" (couldn't tell — which is NOT the same as being wrongly formatted).
  function detectFormat(r) {
    const raw = String((r && (r.raw || r.title)) || "").trim();
    const marker = String((r && r.marker) || "").trim();
    const head = raw.slice(0, 120);
    // numbered signals
    if (/^\d{1,3}$/.test(marker)) return "numbered";
    if (/^\[?\(?\s*\d{1,3}\s*[\].)]/.test(raw)) return "numbered";
    // author-year signals
    if (/[A-Za-z].*\b(19|20)\d{2}[a-z]?\b/.test(marker)) return "author-year";
    if (/\(\s*(19|20)\d{2}[a-z]?\s*\)/.test(head)) return "author-year";           // "... (2020) ..."
    if (/^[A-Z][A-Za-z'’-]+,\s+[A-Z]\.?(?:[^.]*\b(19|20)\d{2}\b)?/.test(head)) return "author-year"; // "Surname, A."
    return "other";
  }
  function runFormatCheck() {
    if (!currentResult) return;
    const refs = currentResult.references || [];
    const el = $("format-result"); el.classList.remove("hidden");
    if (!refs.length) { el.innerHTML = '<span class="text-ink-mute">No references to check.</span>'; return; }
    // Anchor the "expected" style to what the backend already determined for the whole document,
    // rather than re-guessing from a tally that can be dominated by "unrecognized" entries.
    const majority = inferStyle(currentResult) === "author-year" ? "author-year" : "numbered";
    const opposite = majority === "numbered" ? "author-year" : "numbered";
    const styleName = { numbered: "numbered (Vancouver-style)", "author-year": "author–year (APA-style)" };
    const sigs = refs.map((r) => ({ r, sig: detectFormat(r) }));
    // Only flag a reference that is POSITIVELY the other concrete style. "other"/unrecognized is
    // never treated as an inconsistency — an unparsed entry is not a wrongly-formatted one.
    const outliers = sigs.filter((x) => x.sig === opposite);
    if (!outliers.length) {
      el.innerHTML = `<div class="text-ok inline-flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]" style="font-variation-settings:'FILL' 1;">check_circle</span>All ${refs.length} references use a consistent ${escapeHtml(styleName[majority])} format.</div>`;
      return;
    }
    const suggestion = majority === "numbered"
      ? "Reformat these to numbered Vancouver style: <span class='font-mono text-ink-soft'>1. Author AA, Author BB. Title. Journal. Year;Vol(Issue):Pages.</span>"
      : "Reformat these to author–year APA style: <span class='font-mono text-ink-soft'>Author, A. A., &amp; Author, B. B. (Year). Title. Journal, Vol(Issue), Pages.</span>";
    el.innerHTML =
      `<div class="text-warn inline-flex items-center gap-1.5 mb-1.5"><span class="material-symbols-outlined text-[15px]">warning</span>${outliers.length} of ${refs.length} reference${outliers.length === 1 ? "" : "s"} appear to use ${escapeHtml(styleName[opposite])} instead of the document's ${escapeHtml(styleName[majority])} format.</div>` +
      `<ul class="flex flex-col gap-1">${outliers.map((x) => `<li class="text-ink-soft"><span class="font-mono text-ink-mute">[${x.r.id}]</span> ${escapeHtml((x.r.title || x.r.raw || "").slice(0, 60))} <span class="text-ink-mute">— looks ${escapeHtml(styleName[x.sig] || x.sig)}</span></li>`).join("")}</ul>` +
      `<p class="text-ink-mute mt-2">${suggestion}</p>`;
  }

  // ---- claims ----
  function buildCitationInstances(result) {
    citationInstances = [];
    const body = docBody(result);
    if (!body.trim()) return;
    const ranges = computeCitationRanges(result, body);
    let n = 0;
    ranges.forEach((rg) => {
      const claim = extractClaim(body, rg.start, rg.end);
      // Only keep real prose claims. A citation mark that landed inside a reference-list entry, a
      // figure/table caption, or a run of metadata yields something like "2010;39(3):263-272." —
      // that is not a claim to fact-check, so we skip it rather than show nonsense.
      if (!isMeaningfulClaim(claim)) return;
      citationInstances.push({ id: "c" + n++, refId: rg.refId, start: rg.start, claim });
    });
  }
  // A checkable claim reads like a sentence: enough real words, and not dominated by digits/symbols
  // (volume/issue/page/DOI strings from a bibliography entry).
  function isMeaningfulClaim(text) {
    const t = (text || "").trim();
    if (t.length < 25) return false;
    const wordish = (t.match(/[A-Za-z][A-Za-z'’-]{2,}/g) || []);
    if (wordish.length < 6) return false;                 // needs several real words
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const nonSpace = t.replace(/\s/g, "").length || 1;
    if (letters / nonSpace < 0.55) return false;          // mostly numbers/punctuation -> metadata
    return true;
  }
  // expand a citation position to the surrounding sentence (the "claim")
  function extractClaim(body, start, end) {
    let i = start;
    while (i > 0 && !/[.!?]/.test(body[i - 1])) i--;
    const para = body.lastIndexOf("\n\n", start);
    const sStart = Math.max(i, para + 2, start - 400, 0);
    let j = end;
    while (j < body.length && !/[.!?]/.test(body[j])) j++;
    if (j < body.length) j++;
    const sEnd = Math.min(j, end + 400, body.length);
    return body.slice(sStart, sEnd).replace(/\s+/g, " ").trim();
  }

  // ---- source PDFs ----
  function setSrcError(msg) {
    const el = $("src-error");
    if (!msg) { el.classList.add("hidden"); return; }
    el.textContent = msg; el.classList.remove("hidden");
  }
  async function addSourceFiles(files) {
    setSrcError("");
    const pdfs = Array.from(files || []).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) { setSrcError("Please upload PDF files."); return; }
    for (const f of pdfs) {
      if (f.size > MAX_BYTES) { setSrcError(`${f.name} is larger than 20 MB.`); continue; }
      const paper = { id: "s" + (++srcIdSeq), filename: f.name, text: "", title: "", refId: null, loading: true, error: "" };
      sourcePapers.push(paper);
      renderSources();
      try {
        paper.text = await extractPdf(f);
        if (paper.text.replace(/\s/g, "").length < 40) throw new Error("scanned");
        paper.title = guessTitle(paper.text);
        paper.refId = autoMatch(paper);
      } catch (_) {
        paper.error = "Couldn't read this PDF (it may be scanned/image-only).";
      }
      paper.loading = false;
      renderSources();
      // Grounded, full-PDF AI verification against the auto-assigned reference (async). Falls through
      // harmlessly when nothing was auto-matched — the user can still assign it manually.
      await verifyAndSync(paper);
    }
  }
  function guessTitle(text) {
    const head = text.slice(0, 1500).split("\n").map((l) => l.trim()).filter(Boolean);
    return (head.find((l) => l.length >= 20 && l.length <= 200) || head[0] || "").slice(0, 200);
  }
  // Cheap local ROUTER only: which reference is this PDF probably for? Token overlap on the title,
  // corroborated by author/year, picks the most likely candidate for auto-assignment. This never
  // decides the verdict — the grounded full-PDF AI check (verifySourceMatch) does that.
  function sourceMatch(paper, ref) {
    const hay = (paper.text || "").slice(0, 8000).toLowerCase();
    const tt = tokenize(ref.title);
    if (!hay || !tt.length) return { overlap: 0, hit: 0 };
    let hit = 0;
    tt.forEach((w) => { if (hay.includes(w)) hit++; });
    const overlap = hit / tt.length;
    const sur = firstSurname(ref.authors) || "";
    const authorHit = sur.length > 2 && hay.includes(sur.toLowerCase());
    const yr = (String(ref.year || "").match(/\d{4}/) || [])[0] || "";
    const yearHit = !!yr && hay.includes(yr);
    // a small bonus for author/year so the router prefers the fuller corroboration on ties
    return { overlap: overlap + (authorHit ? 0.05 : 0) + (yearHit ? 0.03 : 0), hit };
  }
  // Grounded verification: send the ENTIRE PDF to the backend, which reads it in full and (with quotes
  // pulled straight from the PDF) decides whether it truly is the cited reference. Result is cached on
  // paper.aiMatch; only a "confirmed" verdict for the currently assigned ref upgrades the score.
  async function verifySourceMatch(paper) {
    if (paper.refId == null || !paper.text || paper.error) { paper.aiMatch = null; return; }
    const ref = refById(paper.refId);
    if (!ref) { paper.aiMatch = null; return; }
    paper.aiMatch = { status: "checking", refId: paper.refId };
    renderSources();
    try {
      const { data, error } = await Core.run({
        action: "match", paperText: paper.text,
        ref: { title: ref.title, authors: ref.authors, year: ref.year, journal: ref.journal, raw: ref.raw, doi: ref.doi },
      });
      if (error) throw new Error(error.message || "Verification failed.");
      if (data && data.error) throw new Error(data.error);
      paper.aiMatch = { status: "done", refId: paper.refId, ...data };
    } catch (err) {
      paper.aiMatch = { status: "error", refId: paper.refId, error: err.message };
    }
  }
  // Verify a single PDF against its assigned reference, then re-apply evidence + repaint the score.
  async function verifyAndSync(paper) {
    await verifySourceMatch(paper);
    syncSourceEvidence();
  }
  // A single side-by-side "claim vs. source" comparison card: the exact sentence(s) from the user's
  // manuscript, a verdict, and the actual paragraph pulled verbatim from the source PDF that supports or
  // contradicts it, plus a plain-English explanation contrasting the two. This is the heart of the
  // source-PDF check — real text blocks from both documents, not metadata scraps.
  function pairedComparisonHtml(claimText, res, refId) {
    const a = ASSESS[res.assessment] || ASSESS.unclear;
    const articleBlock = `<div class="rounded-md bg-white/[0.03] border-l-2 border-border-strong pl-3 pr-2.5 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wide text-ink-mute mb-1">From your article</div>
        <p class="text-[12.5px] text-ink italic leading-relaxed">&ldquo;${escapeHtml(claimText)}&rdquo;</p>
      </div>`;
    const verdictRow = `<div class="flex items-center justify-center gap-1.5 text-${a.color} text-[12px] font-semibold py-0.5"><span class="material-symbols-outlined text-[16px]" style="font-variation-settings:'FILL' 1;">${a.icon}</span>${a.label}</div>`;
    const sourceBlock = res.sourceQuote
      ? `<div class="rounded-md bg-white/[0.03] border-l-2 border-${a.color}/60 pl-3 pr-2.5 py-2">
           <div class="text-[10px] font-mono uppercase tracking-wide text-ink-mute mb-1">What source [${refId}] actually says</div>
           <p class="text-[12.5px] text-ink italic leading-relaxed">&ldquo;${escapeHtml(res.sourceQuote)}&rdquo;</p>
         </div>`
      : `<div class="text-[11px] text-ink-mute italic px-1 py-1">No matching passage found in this source for that claim.</div>`;
    const expl = res.explanation
      ? `<p class="text-[12px] text-ink-soft mt-1 leading-relaxed">${escapeHtml(res.explanation)}</p>` : "";
    return `<div class="rounded-lg border border-${a.color}/20 bg-${a.color}/10 p-2.5 flex flex-col gap-1.5">
      ${articleBlock}${verdictRow}${sourceBlock}${expl}
    </div>`;
  }

  // Source-PDF evidence panel. For a CONFIRMED match it stops being a metadata dump and instead SHOWS ITS
  // WORK: for every place the manuscript cites this reference, it lays the article's claim next to the real
  // paragraph pulled from the source PDF and says whether it holds up. For partial/mismatch it keeps a short
  // identity explanation (the PDF isn't the cited work, so claim-checking against it would be meaningless).
  function sourceEvidenceHtml(ai, refId) {
    if (!ai) return "";
    if (ai.status === "checking") {
      return `<div class="src-evidence mt-2 rounded-lg bg-white/[0.02] border border-border-subtle px-3 py-2.5 text-[11px] text-ink-mute flex items-center gap-2"><span class="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin"></span>Reading the entire PDF and verifying it against reference [${refId}]…</div>`;
    }
    if (ai.status === "error") {
      return `<div class="src-evidence mt-2 rounded-lg bg-bad/10 border border-bad/30 px-3 py-2.5 text-[11px] text-bad">Couldn't verify this PDF: ${escapeHtml(ai.error || "")}</div>`;
    }
    const V = {
      confirmed: { c: "ok", i: "verified", l: `Confirmed — this PDF is reference [${refId}]` },
      partial: { c: "warn", i: "rule", l: `Likely reference [${refId}], with discrepancies` },
      mismatch: { c: "bad", i: "cancel", l: `Not reference [${refId}] — a different work` },
    }[ai.verdict] || { c: "ink-mute", i: "help", l: "Unclear" };
    const header = `<div class="flex items-center gap-1.5 text-${V.c} text-[11px] font-semibold mb-1.5"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">${V.i}</span>${V.l}</div>`;

    const metaRow = (label, val) => val
      ? `<div class="flex gap-2"><span class="text-ink-mute shrink-0 w-16">${label}</span><span class="text-ink-soft min-w-0">${escapeHtml(val)}</span></div>` : "";
    const meta = [
      metaRow("PDF title", ai.foundTitle),
      metaRow("Authors", ai.foundAuthors),
      metaRow("Year", ai.foundYear),
    ].filter(Boolean).join("");

    // --- CONFIRMED or PARTIAL: show the paragraph-level claim-vs-source comparisons ---
    // A "partial" verdict usually means a metadata quibble (often a DOI that came from a database
    // lookup rather than the manuscript). That is worth surfacing, but it must NOT hide the actual
    // claim-vs-source evidence — which is the whole point of uploading the PDF.
    if (ai.verdict === "confirmed" || ai.verdict === "partial") {
      const citing = citationInstances.filter((inst) => inst.refId === refId);
      const checkable = citing.filter((inst) => basisForInstance(inst));
      let body;
      if (!citing.length) {
        body = `<p class="text-[11px] text-ink-mute leading-relaxed">This is the right paper, but I couldn't locate an in-text citation to <span class="font-mono">[${refId}]</span> in your manuscript to compare against.</p>`;
      } else {
        const cards = checkable.map((inst) => {
          const r = citeResults[inst.id];
          if (r && r.status === "done") return pairedComparisonHtml(inst.claim, r, refId);
          if (r && r.status === "error") return `<div class="text-[11px] text-bad px-1">Couldn't compare one claim: ${escapeHtml(r.error || "")}</div>`;
          return `<div class="text-[11px] text-ink-mute flex items-center gap-2 px-1 py-1.5"><span class="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin"></span>Reading the source and comparing this claim…</div>`;
        }).join("");
        const skipped = citing.length - checkable.length;
        const note = skipped > 0 ? `<div class="text-[10px] text-ink-mute mt-1">${skipped} other mention${skipped === 1 ? "" : "s"} of this reference ${skipped === 1 ? "is" : "are"} too short to fact-check (e.g. a bare citation).</div>` : "";
        body = `<div class="text-[10px] font-mono uppercase tracking-wide text-ink-mute mb-1.5">How your article uses this source · ${checkable.length} claim${checkable.length === 1 ? "" : "s"}</div>
          <div class="flex flex-col gap-2">${cards}</div>${note}`;
      }
      // For "partial", surface the identity discrepancy in a compact note ABOVE the evidence.
      const discrepancy = ai.verdict === "partial"
        ? `<details class="mb-2.5 rounded-md bg-warn/10 border border-warn/20 px-2.5 py-2">
             <summary class="text-[11px] text-warn cursor-pointer select-none">Metadata discrepancy vs. reference [${refId}] — details</summary>
             <p class="text-[11.5px] text-ink-soft leading-relaxed mt-1.5">${escapeHtml(ai.explanation || "")}</p>
             ${meta ? `<div class="mt-1.5 flex flex-col gap-0.5 text-[11px]">${meta}</div>` : ""}
           </details>`
        : "";
      // The conclusion reflects the CLAIM outcome, not just identity. A real paper that doesn't support
      // the claim it's cited for is a citation error — never show a green "verified" under a red card.
      const claimAssess = citing
        .map((inst) => citeResults[inst.id]).filter((x) => x && x.status === "done").map((x) => x.assessment);
      const anyDone = claimAssess.length > 0;
      const conclusion = claimAssess.includes("not_supported")
        ? `<div class="mt-2 text-[11px] text-bad flex items-start gap-1.5"><span class="material-symbols-outlined text-[13px]" style="font-variation-settings:'FILL' 1;">cancel</span><span>This is the right paper, but it does <b>not</b> support the claim it's cited for — reference [${refId}] is <b>flagged as a citation error</b>, not verified.</span></div>`
        : claimAssess.includes("partial")
        ? `<div class="mt-2 text-[11px] text-warn flex items-start gap-1.5"><span class="material-symbols-outlined text-[13px]">rule</span><span>This is the right paper, but the citation <b>overstates</b> it — reference [${refId}] is marked <b>for review</b>.</span></div>`
        : anyDone
        ? `<div class="mt-2 text-[11px] text-ok flex items-start gap-1.5"><span class="material-symbols-outlined text-[13px]" style="font-variation-settings:'FILL' 1;">verified</span><span>Reference [${refId}] is real <b>and</b> the claim checks out — counted as <b>verified</b>.</span></div>`
        : `<div class="mt-2 text-[11px] text-ink-mute flex items-start gap-1.5"><span class="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin mt-0.5"></span><span>Confirmed as reference [${refId}] — checking the claim${citing.length === 1 ? "" : "s"} against it…</span></div>`;
      return `<div class="src-evidence mt-2 rounded-lg bg-white/[0.02] border border-border-subtle px-3 py-2.5">
        ${header}
        ${discrepancy}
        ${body}
        ${conclusion}
      </div>`;
    }

    // --- MISMATCH: a genuinely different work; claim-checking against it would be meaningless ---
    const conclusion = `<div class="mt-2 text-[11px] text-bad flex items-start gap-1.5"><span class="material-symbols-outlined text-[13px]">cancel</span><span>Score left unchanged — this PDF is not the cited work. Assign the correct source PDF.</span></div>`;
    return `<div class="src-evidence mt-2 rounded-lg bg-white/[0.02] border border-border-subtle px-3 py-2.5">
      ${header}
      <p class="text-[12px] text-ink-soft leading-relaxed">${escapeHtml(ai.explanation || "")}</p>
      ${meta ? `<div class="mt-2 flex flex-col gap-0.5 text-[11px]">${meta}</div>` : ""}
      ${conclusion}
    </div>`;
  }
  // Auto-assign the most likely reference (loose local router). The grounded AI check then confirms or
  // rejects it — so a wrong auto-assignment is caught and never inflates the score.
  function autoMatch(paper) {
    let best = null, bestOverlap = 0;
    (currentResult.references || []).forEach((r) => {
      const m = sourceMatch(paper, r);
      if (m.overlap > bestOverlap && m.overlap >= 0.4 && m.hit >= 2) { bestOverlap = m.overlap; best = r.id; }
    });
    return best;
  }
  function renderSources() {
    const list = $("src-list");
    $("src-count").textContent = sourcePapers.length ? `${sourcePapers.length} uploaded` : "";
    if (!sourcePapers.length) { list.innerHTML = ""; return; }
    const opts = (sel) => (currentResult.references || [])
      .map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>[${r.id}] ${escapeHtml((r.title || r.raw || "").slice(0, 55))}</option>`).join("");
    list.innerHTML = sourcePapers.map((p) => {
      const matched = p.refId != null ? refById(p.refId) : null;
      // aiMatch is authoritative only when it targets the currently assigned reference.
      const ai = matched && p.aiMatch && p.aiMatch.refId === p.refId ? p.aiMatch : null;
      const status = p.loading ? '<span class="text-ink-mute">Reading…</span>'
        : p.error ? `<span class="text-bad">${escapeHtml(p.error)}</span>`
        : !matched ? '<span class="text-warn">No automatic match — assign it →</span>'
        : ai && ai.status === "checking" ? `<span class="text-ink-mute inline-flex items-center gap-1"><span class="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin"></span>Reading the full PDF &amp; verifying against [${p.refId}]…</span>`
        : ai && ai.status === "error" ? `<span class="text-bad">Verification failed — ${escapeHtml(ai.error || "")}</span>`
        : ai && ai.status === "done" && ai.verdict === "confirmed" ? `<span class="text-ok inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]" style="font-variation-settings:'FILL' 1;">verified</span>Confirmed → [${p.refId}] (verifies it)</span>`
        : ai && ai.status === "done" && ai.verdict === "partial" ? `<span class="text-warn inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">rule</span>Likely [${p.refId}] — discrepancy, review</span>`
        : ai && ai.status === "done" && ai.verdict === "mismatch" ? `<span class="text-bad inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">cancel</span>Doesn't match [${p.refId}] — score unchanged</span>`
        : `<span class="text-ink-mute">Assigned to [${p.refId}]</span>`;
      const select = p.loading || p.error ? "" :
        `<select class="src-assign bg-surface-2 border border-border-subtle rounded-md text-xs text-ink px-2 py-1 max-w-[170px]" data-src="${p.id}">
           <option value="">— unmatched —</option>${opts(p.refId)}
         </select>`;
      const showEvidence = matched && ai && !p.loading && !p.error;
      return `<div class="glass rounded-lg p-3">
        <div class="flex items-center gap-3">
          <span class="material-symbols-outlined text-ink-soft text-[20px] shrink-0">picture_as_pdf</span>
          <div class="min-w-0 flex-grow"><div class="text-sm text-white truncate">${escapeHtml(p.filename)}</div><div class="text-[11px] mt-0.5">${status}</div></div>
          ${select}
          <button class="src-remove text-ink-mute hover:text-bad p-1 shrink-0" data-src="${p.id}" title="Remove"><span class="material-symbols-outlined text-[18px]">close</span></button>
        </div>
        ${showEvidence ? sourceEvidenceHtml(ai, p.refId) : ""}
      </div>`;
    }).join("");
    list.querySelectorAll(".src-assign").forEach((sel) => sel.addEventListener("change", (e) => {
      const p = sourcePapers.find((x) => x.id === e.target.dataset.src); if (!p) return;
      p.refId = e.target.value ? parseInt(e.target.value, 10) : null;
      p.aiMatch = null;          // old verdict no longer applies to the new reference
      renderSources();
      verifyAndSync(p);          // re-verify the full PDF against the newly chosen reference
    }));
    list.querySelectorAll(".src-remove").forEach((b) => b.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.src;
      sourcePapers = sourcePapers.filter((x) => x.id !== id);
      renderSources(); syncSourceEvidence();
    }));
  }

  // ---- per-citation basis (full text > abstract > none) ----
  function basisForInstance(inst) {
    const sp = sourcePapers.find((p) => p.refId === inst.refId && p.text);
    if (sp) return { basis: "full text", paperText: sp.text, paperTitle: sp.title };
    const ref = refById(inst.refId);
    if (ref && ref.abstract) return { basis: "abstract", paperText: ref.abstract, paperTitle: ref.title };
    return null;
  }

  function renderCitations() {
    const list = $("cite-list"), empty = $("cite-empty"), checkAllBtn = $("cite-check-all");
    if (!list) return;  // standalone citation list removed — comparisons now render inside each source-PDF card
    if (!citationInstances.length) { list.innerHTML = ""; empty.classList.remove("hidden"); checkAllBtn.disabled = true; return; }
    empty.classList.add("hidden");
    list.innerHTML = citationInstances.map((inst) => {
      const ref = refById(inst.refId);
      const b = basisForInstance(inst);
      const res = citeResults[inst.id];
      const basisChip = b
        ? `<span class="text-[11px] text-ink-soft inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">${b.basis === "full text" ? "description" : "subject"}</span>${b.basis === "full text" ? "Full text" : "Abstract only"}</span>`
        : '<span class="text-[11px] text-ink-mute inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">cloud_off</span>No source yet</span>';
      let block = "";
      if (res && res.status === "done") {
        const a = ASSESS[res.assessment] || ASSESS.unclear;
        const quoteBlock = res.sourceQuote
          ? `<div class="mt-2 rounded-md bg-white/[0.03] border-l-2 border-${a.color}/60 pl-3 pr-2.5 py-2">
               <div class="text-[10px] font-mono uppercase tracking-wide text-ink-mute mb-1">What the source actually says</div>
               <p class="text-[12.5px] text-ink italic leading-relaxed">&ldquo;${escapeHtml(res.sourceQuote)}&rdquo;</p>
             </div>` : "";
        block = `<div class="mt-2.5 rounded-lg border border-${a.color}/20 bg-${a.color}/10 px-3 py-2.5">
          <div class="flex items-center gap-1.5 text-${a.color} text-xs font-semibold"><span class="material-symbols-outlined text-[16px]" style="font-variation-settings:'FILL' 1;">${a.icon}</span>${a.label}<span class="text-ink-mute font-normal ml-1">· based on ${res.basis}</span></div>
          ${quoteBlock}
          <p class="text-[12.5px] text-ink-soft mt-2 leading-relaxed">${escapeHtml(res.explanation || "")}</p>
        </div>`;
      } else if (res && res.status === "checking") {
        block = '<div class="mt-2.5 text-xs text-ink-mute flex items-center gap-2"><span class="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin"></span>Checking…</div>';
      } else if (res && res.status === "error") {
        block = `<div class="mt-2.5 text-xs text-bad">${escapeHtml(res.error || "Check failed.")}</div>`;
      }
      const btn = b ? `<button class="cite-one glass px-2.5 py-1.5 rounded-md text-[11px] text-ink hover:border-border-strong inline-flex items-center gap-1" data-inst="${inst.id}"><span class="material-symbols-outlined text-[14px]">fact_check</span>Check this one</button>` : "";
      return `<div class="glass rounded-xl p-4">
        <p class="text-[13px] text-ink leading-relaxed">&ldquo;${escapeHtml(inst.claim)}&rdquo;</p>
        <div class="flex items-center gap-3 mt-2 flex-wrap">
          <span class="font-mono text-[11px] text-ink-mute">cites [${inst.refId}]${ref && ref.title ? " · " + escapeHtml(ref.title.slice(0, 48)) : ""}</span>
          ${basisChip}${btn}
        </div>
        ${block}
        ${currentResult && currentResult.id && res && res.status === "done" ? feedbackBlock("citation", inst.id) : ""}
      </div>`;
    }).join("");
    list.querySelectorAll(".cite-one").forEach((b) => b.addEventListener("click", () => checkOne(b.dataset.inst)));
    wireFeedback(list);
    checkAllBtn.disabled = !citationInstances.some((inst) => basisForInstance(inst));
  }

  async function checkInstance(inst) {
    const b = basisForInstance(inst);
    if (!b) return;
    citeResults[inst.id] = { status: "checking" };
    renderCitations(); renderSources(); renderEvidenceTable();
    try {
      const { data, error } = await Core.run({
        action: "cite", claim: inst.claim, paperText: b.paperText, paperTitle: b.paperTitle,
        basis: b.basis === "abstract" ? "abstract" : "full", strictness: getStrictness(),
      });
      if (error) throw new Error(error.message || "Check failed.");
      if (data && data.error) throw new Error(data.error);
      citeResults[inst.id] = { status: "done", assessment: data.assessment, explanation: data.explanation, sourceQuote: data.sourceQuote || "", basis: b.basis };
    } catch (err) {
      citeResults[inst.id] = { status: "error", error: err.message };
    }
    renderCitations(); renderSources(); renderEvidenceTable(); renderEvidenceSummary();
  }

  // When a source PDF is confirmed to BE a reference, immediately compare every in-text claim that cites
  // that reference against the PDF — so the source panel fills in with real claim-vs-paragraph evidence
  // without the user having to open the Citation tab. Fire-and-forget; each check repaints on completion.
  async function checkClaimsForConfirmedSources() {
    const todo = [];
    sourcePapers.forEach((p) => {
      const ai = p.aiMatch;
      if (!(ai && ai.status === "done" && ai.refId === p.refId && (ai.verdict === "confirmed" || ai.verdict === "partial"))) return;
      citationInstances.forEach((inst) => {
        if (inst.refId !== p.refId || !basisForInstance(inst)) return;
        const r = citeResults[inst.id];
        if (!r || (r.status !== "done" && r.status !== "checking")) todo.push(inst);
      });
    });
    if (!todo.length) return;
    // mark queued up front so a concurrent call doesn't double-fire the same claim
    todo.forEach((inst) => { citeResults[inst.id] = { status: "checking" }; });
    renderCitations(); renderSources(); renderEvidenceTable();
    let idx = 0;
    async function worker() { while (idx < todo.length) { await checkInstance(todo[idx++]); } }
    await Promise.all([worker(), worker()]); // concurrency 2, matches checkAll
    updateCiteSummary(); saveCitationState();
    // claim outcomes may downgrade a reference (real paper, but the claim isn't supported) — re-apply.
    applySourceEvidence(); refreshScoreUI(); renderSources(); renderEvidenceTable(); renderEvidenceSummary();
  }
  async function checkOne(instId) {
    const inst = citationInstances.find((x) => x.id === instId);
    if (!inst) return;
    await checkInstance(inst);
    updateCiteSummary(); saveCitationState();
    applySourceEvidence(); refreshScoreUI(); renderSources();
  }
  async function checkAll() {
    const todo = citationInstances.filter((inst) => basisForInstance(inst) && !(citeResults[inst.id] && citeResults[inst.id].status === "done"));
    if (!todo.length) { updateCiteSummary(); return; }
    const btn = $("cite-check-all");
    if (btn) btn.disabled = true;
    const wrap = $("cite-progress-wrap");
    if (wrap) wrap.classList.remove("hidden");
    let done = 0; setCiteProgress(0);
    const CONC = 2; let idx = 0;
    async function worker() {
      while (idx < todo.length) {
        const inst = todo[idx++];
        await checkInstance(inst);
        done++; setCiteProgress((100 * done) / todo.length);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    if (btn) btn.disabled = false;
    updateCiteSummary(); saveCitationState();
    if (wrap) setTimeout(() => wrap.classList.add("hidden"), 700);
  }
  function setCiteProgress(pct) {
    const bar = $("cite-progress-bar"), label = $("cite-progress-label");
    if (!bar || !label) return;   // progress UI was removed with the standalone citation list
    bar.style.width = pct + "%";
    label.textContent = Math.round(pct) + "%";
  }
  function updateCiteSummary() {
    const el = $("cite-summary");
    if (!el) return;              // summary UI was removed; per-source cards carry the verdicts now
    const counts = { supported: 0, partial: 0, not_supported: 0, unclear: 0 };
    let checkable = 0, checked = 0;
    citationInstances.forEach((inst) => {
      if (basisForInstance(inst)) checkable++;
      const r = citeResults[inst.id];
      if (r && r.status === "done") { checked++; counts[r.assessment] = (counts[r.assessment] || 0) + 1; }
    });
    if (!checked) { el.classList.add("hidden"); return; }
    const noSource = citationInstances.length - checkable;
    el.classList.remove("hidden");
    el.innerHTML =
      `<span class="text-ok font-semibold">${counts.supported}</span> supported · ` +
      `<span class="text-warn font-semibold">${counts.partial}</span> partial · ` +
      `<span class="text-bad font-semibold">${counts.not_supported}</span> not supported · ` +
      `<span class="text-ink font-semibold">${counts.unclear}</span> unclear` +
      (noSource ? ` · <span class="text-ink-mute">${noSource} could not be checked (no PDF or abstract)</span>` : "");
    // fold citation findings into the plain-language verdict banner
    if (currentResult) renderVerdictBanner(currentResult);
  }

  // persist citation assessments to the saved analysis record
  function saveCitationState() {
    if (!currentResult || !currentResult.id) return;
    currentResult.citationResults = citeResults;
    storeUpsert({ id: currentResult.id, citation_results: citeResults });
  }

  // ============================================================
  // Thumbs up/down feedback (stored locally with the analysis)
  // ============================================================
  function fbKey(feature, key) { return feature + ":" + key; }

  function loadFeedback() {
    feedbackMap = {};
    if (!currentResult || !currentResult.id) return Promise.resolve();
    const rec = storeGet(currentResult.id);
    feedbackMap = (rec && rec.feedback) ? { ...rec.feedback } : (currentResult.feedback || {});
    return Promise.resolve();
  }
  function persistFeedback() {
    if (!currentResult || !currentResult.id) return;
    currentResult.feedback = feedbackMap;
    storeUpsert({ id: currentResult.id, feedback: feedbackMap });
  }

  function feedbackBlock(feature, key) {
    const fb = feedbackMap[fbKey(feature, key)];
    const up = fb && fb.rating === "up", down = fb && fb.rating === "down";
    const fill = "font-variation-settings:'FILL' 1;";
    return `<div class="fb flex flex-col gap-1.5 mt-2.5 pt-2 border-t border-border-subtle" data-fb-feature="${feature}" data-fb-key="${escapeHtml(key)}">
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-ink-mute uppercase font-mono tracking-wider">Was this right?</span>
        <button class="fb-up p-1 rounded ${up ? "text-ok" : "text-ink-mute hover:text-ink"}" title="Looks right"><span class="material-symbols-outlined text-[15px]" style="${up ? fill : ""}">thumb_up</span></button>
        <button class="fb-down p-1 rounded ${down ? "text-bad" : "text-ink-mute hover:text-ink"}" title="Looks wrong"><span class="material-symbols-outlined text-[15px]" style="${down ? fill : ""}">thumb_down</span></button>
      </div>
      ${down ? `<input class="fb-comment w-full bg-surface-2 border border-border-subtle rounded text-[11px] text-ink px-2 py-1" placeholder="Optional: what was wrong?" value="${escapeHtml(fb.comment || "")}">` : ""}
    </div>`;
  }

  function wireFeedback(container) {
    container.querySelectorAll(".fb").forEach((el) => {
      const feature = el.dataset.fbFeature, key = el.dataset.fbKey;
      el.querySelector(".fb-up").addEventListener("click", (e) => { e.stopPropagation(); setFeedback(feature, key, "up"); });
      el.querySelector(".fb-down").addEventListener("click", (e) => { e.stopPropagation(); setFeedback(feature, key, "down"); });
      const c = el.querySelector(".fb-comment");
      if (c) {
        c.addEventListener("click", (e) => e.stopPropagation());
        c.addEventListener("change", () => saveComment(feature, key, c.value));
      }
    });
  }

  function setFeedback(feature, key, rating) {
    if (!currentResult || !currentResult.id) return;
    const k = fbKey(feature, key), cur = feedbackMap[k];
    if (cur && cur.rating === rating) delete feedbackMap[k];            // click active rating again clears it
    else feedbackMap[k] = { rating, comment: cur ? cur.comment : "" };
    persistFeedback();
    renderRefs(currentResult.references); renderCitations();
  }
  function saveComment(feature, key, comment) {
    const k = fbKey(feature, key); if (!feedbackMap[k]) return;
    feedbackMap[k].comment = comment;
    persistFeedback();
  }

  // ============================================================
  // Settings (Gemini key / email / model / daily limit) + fact-check strictness
  // ============================================================
  function getStrictness() {
    const el = $("strictness");
    if (el) return el.value === "critical" ? "critical" : "broad";
    return (localStorage.getItem("refcheck-strictness") === "critical") ? "critical" : "broad";
  }
  function refreshKeyNudge() {
    const nudge = $("key-nudge");
    if (nudge) nudge.classList.toggle("hidden", !!Core.getSettings().geminiKey);
  }
  function refreshUsageLine() {
    const el = $("usage-line");
    if (!el) return;
    const u = Core.usageToday(), s = Core.getSettings();
    el.textContent = `Used ${u.count} of ${s.dailyLimit} AI checks today.`;
  }
  function openSettings(show) {
    const p = $("settings-panel");
    if (!p) return;
    p.classList.toggle("hidden", show === false);
    if (show !== false) p.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  }
  function wireSettings() {
    const email = $("set-email"), key = $("set-key"), model = $("set-model"), limit = $("set-limit");
    const s = Core.getSettings();
    if (email) email.value = s.email;
    if (key) key.value = s.geminiKey;
    // Model is locked to the single allowed option; never inject a stored/foreign model into the picker.
    if (model && [...model.options].some((o) => o.value === s.model)) model.value = s.model;
    if (limit) limit.value = s.dailyLimit;
    refreshKeyNudge(); refreshUsageLine();

    const save = () => {
      Core.saveSettings({
        email: email ? email.value.trim() : "",
        geminiKey: key ? key.value.trim() : "",
        model: model ? model.value : "gemini-3.5-flash-lite",
        dailyLimit: limit ? Math.max(1, parseInt(limit.value, 10) || 200) : 200,
      });
      refreshKeyNudge(); refreshUsageLine();
    };
    [email, model, limit].forEach((el) => { if (el) el.addEventListener("change", save); });
    if (key) key.addEventListener("input", save);

    const sBtn = $("settings-btn"); if (sBtn) sBtn.addEventListener("click", () => { showView("upload"); openSettings(true); });
    const close = $("settings-close"); if (close) close.addEventListener("click", () => openSettings(false));
    const link = $("key-nudge-link"); if (link) link.addEventListener("click", () => openSettings(true));

    const strict = $("strictness");
    if (strict) {
      strict.value = getStrictness();
      strict.addEventListener("change", () => {
        try { localStorage.setItem("refcheck-strictness", strict.value); } catch (_) {}
        rerunCitationsForStrictness();
      });
    }
  }
  // Strictness changed → previous claim assessments are stale; clear and re-run for confirmed sources.
  function rerunCitationsForStrictness() {
    if (!currentResult) return;
    citeResults = {};
    saveCitationState();
    applySourceEvidence(); refreshScoreUI();
    renderCitations(); renderSources(); renderEvidenceTable(); renderEvidenceSummary();
    checkClaimsForConfirmedSources();
  }

  // ============================================================
  // Phase 4 — "Check citation accuracy" run + evidence table
  // ============================================================
  let evidenceRunning = false, evidenceStopFlag = false;
  let evDone = 0, evTotal = 0, throttleUntil = 0, throttleTimer = null;

  function checkableInstances() { return citationInstances.filter((inst) => basisForInstance(inst)); }

  function setEvStatus(msg) { const el = $("evidence-status"); if (el) el.textContent = msg; }
  function setEvBar(done, total) { const b = $("evidence-bar"); if (b) b.style.width = (total ? Math.round(100 * done / total) : 0) + "%"; }

  // Fetch abstracts (no Gemini key needed) for cited references that don't have one yet, so they become
  // checkable. Only refs that (a) are cited in the body, (b) exist in a database, (c) have no abstract and
  // (d) have no uploaded source PDF are attempted. Runs a few at a time; results persist with the analysis.
  async function fillMissingAbstracts() {
    if (!currentResult || !window.RefCheckCore || typeof Core.fetchAbstract !== "function") return;
    const citedIds = new Set(citationInstances.map((i) => i.refId));
    const need = [...citedIds]
      .map((id) => refById(id))
      .filter((ref) => ref && ref.exists && !(ref.abstract && String(ref.abstract).trim())
        && !sourcePapers.some((p) => p.refId === ref.id && p.text));
    if (!need.length) return;
    $("evidence-progress").classList.remove("hidden");
    setEvBar(0, 1);
    let got = 0, done = 0;
    const CONC = 3;
    let idx = 0;
    async function worker() {
      while (idx < need.length) {
        const ref = need[idx++];
        setEvStatus(`Fetching source abstracts… (${done}/${need.length})`);
        try { const abs = await Core.fetchAbstract(ref); if (abs) { ref.abstract = abs; got++; } } catch (_) {}
        done++;
        setEvBar(done, need.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, need.length) }, worker));
    if (got) { try { saveReferences(); } catch (_) {} }
    setEvBar(0, 1);
  }

  async function runEvidenceCheck() {
    if (evidenceRunning) return;
    if (!currentResult) return;
    if (!Core.getSettings().geminiKey) {
      $("evidence-progress").classList.remove("hidden");
      setEvBar(0, 1); setEvStatus("Add your Gemini API key in Settings to run the accuracy check.");
      openSettings(true);
      return;
    }
    // On-demand abstract fill: any reference that IS cited in the text and exists in a database, but has
    // no abstract yet and no uploaded PDF, gets one fetched now (OpenAlex/Europe PMC/CrossRef — no key).
    // This is what turns "1 of 13" into "most of 13": abstracts missed during analysis are recovered here.
    await fillMissingAbstracts();

    const all = checkableInstances();
    const todo = all.filter((inst) => !(citeResults[inst.id] && citeResults[inst.id].status === "done"));
    evTotal = all.length;
    evDone = evTotal - todo.length;
    if (!evTotal) { $("evidence-progress").classList.remove("hidden"); setEvStatus("No citations have a readable source to check — upload the source PDFs, or the cited works are paywalled with no abstract."); return; }
    evidenceRunning = true; evidenceStopFlag = false;
    $("evidence-run").classList.add("hidden");
    $("evidence-stop").classList.remove("hidden");
    $("evidence-progress").classList.remove("hidden");
    setEvBar(evDone, evTotal);
    setEvStatus(`Checking ${evTotal} citation${evTotal === 1 ? "" : "s"}… (${evDone}/${evTotal} done)`);
    for (const inst of todo) {
      if (evidenceStopFlag) break;
      await checkInstance(inst);        // Gemini scheduler paces + auto-retries; throttle events drive the status
      evDone++;
      setEvBar(evDone, evTotal);
      if (!throttleUntil) setEvStatus(`Checking citations… (${evDone}/${evTotal} done)`);
    }
    evidenceRunning = false;
    $("evidence-stop").classList.add("hidden");
    $("evidence-run").classList.remove("hidden");
    updateCiteSummary(); saveCitationState();
    applySourceEvidence(); refreshScoreUI();
    renderEvidenceTable(); renderEvidenceSummary();
    setEvStatus(evidenceStopFlag
      ? `Stopped at ${evDone}/${evTotal}. Press Run check to resume — finished checks are kept.`
      : `Done — checked ${evDone} of ${evTotal} citation${evTotal === 1 ? "" : "s"}.`);
  }
  function stopEvidenceCheck() { evidenceStopFlag = true; setEvStatus("Stopping after the current check…"); }

  // Show the rate-limit pause as a live countdown (so it never looks stuck).
  function updateThrottleStatus() {
    if (!throttleUntil) return;
    const secs = Math.max(0, Math.ceil((throttleUntil - Date.now()) / 1000));
    if (evidenceRunning) setEvStatus(`Hit the rate limit — pausing ${secs}s, then continuing automatically… (${evDone}/${evTotal} done)`);
  }
  window.addEventListener("refcheck-throttle", (e) => {
    throttleUntil = (e.detail && e.detail.until) || (Date.now() + 30000);
    updateThrottleStatus();
    if (throttleTimer) clearInterval(throttleTimer);
    throttleTimer = setInterval(updateThrottleStatus, 500);
  });
  window.addEventListener("refcheck-throttle-end", () => {
    throttleUntil = 0;
    if (throttleTimer) { clearInterval(throttleTimer); throttleTimer = null; }
    if (evidenceRunning) setEvStatus(`Resuming… (${evDone}/${evTotal} done)`);
  });

  const EV_CHIP = (color, text) => `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-${color}/10 text-${color} border border-${color}/20">${text}</span>`;
  function renderEvidenceSummary() {
    const el = $("evidence-summary"); if (!el) return;
    let sup = 0, par = 0, ns = 0, unc = 0, nosrc = 0;
    citationInstances.forEach((inst) => {
      const b = basisForInstance(inst), res = citeResults[inst.id];
      if (!b) { nosrc++; return; }
      if (res && res.status === "done") {
        if (res.assessment === "supported") sup++;
        else if (res.assessment === "partial") par++;
        else if (res.assessment === "not_supported") ns++;
        else unc++;
      }
    });
    if (sup + par + ns + unc + nosrc === 0) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML =
      EV_CHIP("ok", `${sup} supported`) + EV_CHIP("warn", `${par} nuance`) + EV_CHIP("bad", `${ns} not supported`) +
      (unc ? EV_CHIP("ink-mute", `${unc} unclear`) : "") + (nosrc ? EV_CHIP("ink-mute", `${nosrc} no source`) : "");
  }

  function renderEvidenceTable() {
    const tbl = $("evidence-table"), wrap = $("evidence-wrap"), empty = $("evidence-empty"), exp = $("evidence-export");
    if (!tbl) return;
    const groups = {};
    citationInstances.forEach((inst) => { (groups[inst.refId] = groups[inst.refId] || []).push(inst); });
    const refIds = Object.keys(groups).map(Number).sort((a, b) => a - b);
    if (!refIds.length) {
      if (wrap) wrap.classList.add("hidden");
      if (exp) exp.classList.add("hidden");
      if (empty) { empty.classList.remove("hidden"); empty.textContent = "No in-text citations were detected in the manuscript body to check."; }
      return;
    }
    const head = `<thead><tr class="text-ink-mute font-mono text-[10px] uppercase tracking-wide border-b border-border-strong">
      <th class="py-2 pr-3 font-normal align-bottom w-[26%]">Reference</th>
      <th class="py-2 px-3 font-normal align-bottom">Claim in the manuscript</th>
      <th class="py-2 px-3 font-normal align-bottom">What the source says</th>
      <th class="py-2 pl-3 font-normal align-bottom w-[16%]">Verdict</th></tr></thead>`;
    let anyDone = false;
    const body = refIds.map((rid) => {
      const insts = groups[rid], ref = refById(rid);
      const b = basisForInstance(insts[0]);
      const name = ref ? (ref.title || ref.raw || `[${rid}]`) : `[${rid}]`;
      const basisChip = b ? (b.basis === "full text" ? "source PDF" : "abstract") : "no source";
      return insts.map((inst, i) => {
        const res = citeResults[inst.id];
        let quote, verdict;
        if (res && res.status === "done") {
          anyDone = true;
          const a = ASSESS[res.assessment] || ASSESS.unclear;
          quote = res.sourceQuote ? `&ldquo;${escapeHtml(res.sourceQuote)}&rdquo;` : `<span class="text-ink-mute not-italic">No matching passage found in the source.</span>`;
          verdict = `<span class="inline-flex items-center gap-1 text-${a.color} font-medium"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">${a.icon}</span>${a.label}</span>`;
        } else if (!b) {
          quote = `<span class="text-ink-mute not-italic">The cited work has no uploaded PDF and no accessible abstract (likely paywalled), so the claim couldn't be verified. Upload the source PDF to check it.</span>`;
          verdict = `<span class="text-ink-mute">No accessible source</span>`;
        } else if (res && res.status === "checking") {
          quote = `<span class="text-ink-mute not-italic inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin"></span>Reading the source…</span>`;
          verdict = `<span class="text-ink-mute">Checking…</span>`;
        } else if (res && res.status === "error") {
          quote = `<span class="text-bad not-italic">${escapeHtml(res.error || "Check failed.")}</span>`;
          verdict = `<span class="text-bad">Error</span>`;
        } else {
          quote = `<span class="text-ink-mute not-italic">Not checked yet — will read the ${b.basis === "full text" ? "source PDF" : "abstract"}.</span>`;
          verdict = `<span class="text-ink-mute">Pending</span>`;
        }
        const refCell = i === 0
          ? `<td rowspan="${insts.length}" class="align-top py-2.5 pr-3 border-b border-border-subtle">
               <div class="text-white leading-snug">${escapeHtml(name.length > 110 ? name.slice(0, 110) + "…" : name)}</div>
               <div class="font-mono text-[10px] text-ink-mute mt-1">[${rid}] · cited ${insts.length}&times; · ${basisChip}</div>
             </td>` : "";
        return `<tr>${refCell}
          <td class="align-top py-2.5 px-3 border-b border-border-subtle text-ink">&ldquo;${escapeHtml(inst.claim)}&rdquo;</td>
          <td class="align-top py-2.5 px-3 border-b border-border-subtle text-ink-soft italic leading-relaxed">${quote}</td>
          <td class="align-top py-2.5 pl-3 border-b border-border-subtle">${verdict}</td></tr>`;
      }).join("");
    }).join("");
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    if (wrap) wrap.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    if (exp) exp.classList.toggle("hidden", !anyDone);
  }

  function exportEvidenceCsv() {
    const rows = [["Reference", "Ref #", "Times cited", "Basis", "Claim in manuscript", "What the source says", "Verdict"]];
    const groups = {};
    citationInstances.forEach((inst) => { (groups[inst.refId] = groups[inst.refId] || []).push(inst); });
    Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((rid) => {
      const insts = groups[rid], ref = refById(rid), b = basisForInstance(insts[0]);
      insts.forEach((inst) => {
        const res = citeResults[inst.id];
        const verdict = !b ? "No accessible source"
          : (res && res.status === "done") ? (ASSESS[res.assessment] || ASSESS.unclear).label
          : (res && res.status === "error") ? "Error" : "Not checked";
        rows.push([ref ? (ref.title || ref.raw || "") : "", rid, insts.length, b ? b.basis : "none",
          inst.claim, (res && res.sourceQuote) || "", verdict]);
      });
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `evidence-${(currentResult && currentResult.filename ? currentResult.filename.replace(/\.[^.]+$/, "") : "table")}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wirePhase3() {
    const srcInput = $("src-input"), srcDrop = $("src-dropzone");
    srcInput.addEventListener("change", (e) => { addSourceFiles(e.target.files); srcInput.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => srcDrop.addEventListener(ev, (e) => { e.preventDefault(); srcDrop.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) => srcDrop.addEventListener(ev, (e) => { e.preventDefault(); srcDrop.classList.remove("dragover"); }));
    srcDrop.addEventListener("drop", (e) => { if (e.dataTransfer.files && e.dataTransfer.files.length) addSourceFiles(e.dataTransfer.files); });
    const checkAllBtn = $("cite-check-all"); if (checkAllBtn) checkAllBtn.addEventListener("click", checkAll);
    $("format-check-btn").addEventListener("click", runFormatCheck);
    const evRun = $("evidence-run"); if (evRun) evRun.addEventListener("click", runEvidenceCheck);
    const evStop = $("evidence-stop"); if (evStop) evStop.addEventListener("click", stopEvidenceCheck);
    const evExp = $("evidence-export"); if (evExp) evExp.addEventListener("click", exportEvidenceCsv);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();

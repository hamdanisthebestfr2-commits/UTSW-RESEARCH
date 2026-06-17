// ============================================================
// REF/CHECK AI — app workspace logic
// Auth gate → file upload → client-side text extraction (pdf.js / mammoth)
// → invoke secure `verify` Edge Function (Gemini + CrossRef) → render + persist.
// ============================================================
(function () {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- config guard ----
  const configured = window.SUPABASE_URL && !/YOUR-PROJECT/.test(window.SUPABASE_URL)
    && window.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(window.SUPABASE_ANON_KEY);
  if (!configured || !window.supabase) { location.replace("auth.html"); return; }

  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

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

  // ============================================================
  // Session gate
  // ============================================================
  (async function init() {
    const { data } = await sb.auth.getSession();
    if (!(data && data.session)) { location.replace("auth.html"); return; }
    const user = data.session.user;
    const email = user.email || "";
    $("user-email").textContent = email;
    $("user-avatar").textContent = (email[0] || "U").toUpperCase();
    gate.classList.add("hidden");
    app.classList.remove("hidden");
    initInteractions();
    loadHistory();
  })();

  $("logout-btn").addEventListener("click", async () => {
    await sb.auth.signOut();
    location.replace("index.html");
  });

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

  fileInput.addEventListener("change", (e) => selectFile(e.target.files[0]));
  $("file-remove").addEventListener("click", () => {
    currentFile = null; fileInput.value = "";
    fileSelected.classList.add("hidden"); analyzeBtn.disabled = true; setError("");
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) selectFile(f);
  });

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
    const headings = /\n\s*(references|bibliography|works cited|literature cited)\s*\n/gi;
    let lastIdx = -1, m;
    while ((m = headings.exec(fullText)) !== null) lastIdx = m.index;
    let slice = lastIdx >= 0 ? fullText.slice(lastIdx) : fullText;
    if (slice.length > 60000) slice = slice.slice(0, 60000);
    return { slice: slice.trim(), bodyEnd: lastIdx >= 0 ? lastIdx : fullText.length };
  }

  // ============================================================
  // Analyze
  // ============================================================
  const STEPS = [
    ["Extracting text", "description"],
    ["Locating references", "format_list_bulleted"],
    ["Checking CrossRef + AI analysis", "neurology"],
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

      // 3) call secure edge function (Gemini + CrossRef)
      const { data, error } = await sb.functions.invoke("verify", {
        body: { filename: currentFile.name, referencesText },
      });
      if (error) {
        let msg = error.message || "Analysis failed.";
        try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (_) {}
        throw new Error(msg);
      }
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

  async function persist(result) {
    try {
      await sb.from("analyses").insert({
        filename: result.filename,
        integrity_score: result.integrityScore,
        counts: result.counts,
        results: result.references,
        document_text: (result.fullText || "").slice(0, 300000),
      });
    } catch (_) { /* non-fatal: still show results */ }
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
    revealStaggers();
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  // ---- document highlighter -------------------------------------------------
  function inferStyle(result) {
    if (result.citationStyle && result.citationStyle !== "unknown") return result.citationStyle;
    const markers = (result.references || []).map((r) => r.marker || "");
    const numeric = markers.filter((m) => /^\d+$/.test(m.trim())).length;
    return numeric >= markers.length / 2 ? "numbered" : "author-year";
  }

  // returns map refId -> occurrence count, and paints #doc-text
  function renderDocument(result) {
    const docEl = $("doc-text");
    const counts = {};
    (result.references || []).forEach((r) => (counts[r.id] = 0));
    const body = (result.fullText || "").slice(0, result.bodyEnd || (result.fullText || "").length);

    if (!body.trim()) {
      docEl.innerHTML = '<p class="text-ink-mute text-sm">Document text isn\'t available for this analysis.</p>';
      $("doc-cite-count").textContent = "";
      return counts;
    }

    const style = inferStyle(result);
    const verdictOf = {};
    (result.references || []).forEach((r) => (verdictOf[r.id] = r.verdict));
    const ranges = []; // {start, end, refId}

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
      // author-year: first-author surname within ~32 chars of its year
      (result.references || []).forEach((r) => {
        const surname = firstSurname(r.authors) || firstSurname(r.marker);
        const year = (String(r.year).match(/\d{4}/) || (r.marker || "").match(/\d{4}/) || [])[0];
        if (!surname || !year) return;
        const re = new RegExp(escapeRe(surname) + "[^.\\n]{0,32}?" + year, "g");
        let m;
        while ((m = re.exec(body)) !== null) {
          ranges.push({ start: m.index, end: m.index + m[0].length, refId: r.id });
          if (re.lastIndex === m.index) re.lastIndex++;
        }
      });
    }

    // merge overlaps (keep earliest); build HTML
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
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
    const shown = activeFilter === "all" ? refs : refs.filter((r) => r.verdict === activeFilter);
    if (!shown.length) {
      list.innerHTML = '<p class="text-sm text-ink-mute text-center py-10">No references in this category.</p>';
      return;
    }
    list.innerHTML = shown.map((r) => {
      const v = VERDICT[r.verdict] || VERDICT.review;
      const meta = [r.authors, [r.journal, r.year].filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
      const n = occurrences[r.id] || 0;
      const cited = n > 0
        ? `<button class="ref-jump inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" data-ref-id="${r.id}"><span class="material-symbols-outlined text-[14px]">my_location</span>Cited ${n}×</button>`
        : `<span class="inline-flex items-center gap-1 text-[11px] text-ink-mute"><span class="material-symbols-outlined text-[14px]">location_off</span>Not found in text</span>`;
      const exists = r.exists
        ? '<span class="inline-flex items-center gap-1 text-[11px] text-ok"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:\'FILL\' 1;">check_circle</span>In CrossRef</span>'
        : '<span class="inline-flex items-center gap-1 text-[11px] text-ink-mute"><span class="material-symbols-outlined text-[14px]">help</span>No CrossRef match</span>';
      const link = r.crossrefUrl
        ? `<a href="${r.crossrefUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors" onclick="event.stopPropagation()"><span class="material-symbols-outlined text-[14px]">link</span>${escapeHtml(r.doi || "DOI")}</a>`
        : "";
      const matched = r.matchedTitle && r.matchedTitle.toLowerCase() !== (r.title || "").toLowerCase()
        ? `<p class="text-[11px] text-ink-mute mt-1.5"><span class="text-ink-soft">Matched:</span> ${escapeHtml(r.matchedTitle)}</p>` : "";
      const conf = typeof r.confidence === "number"
        ? `<div class="flex items-center gap-2 mt-2.5"><span class="font-mono text-[9px] text-ink-mute uppercase">conf</span><div class="conf-bar w-16 h-1 rounded-full bg-white/8 overflow-hidden"><span class="bg-${v.color}" style="width:${Math.round(r.confidence * 100)}%"></span></div></div>` : "";
      return `
      <div class="ref-card glass beam lift rounded-xl p-4" data-ref-id="${r.id}" role="button" tabindex="0">
        <div class="flex gap-3 items-start">
          <span class="material-symbols-outlined text-${v.color} text-[20px] mt-0.5 shrink-0" style="font-variation-settings:'FILL' 1;">${v.icon}</span>
          <div class="min-w-0 flex-grow">
            <div class="flex items-start justify-between gap-3">
              <p class="text-sm text-white leading-snug">${escapeHtml(r.title || r.raw)}</p>
              <span class="shrink-0 font-mono text-[10px] uppercase px-2 py-0.5 rounded-full bg-${v.color}/10 text-${v.color} border border-${v.color}/20">${v.label}</span>
            </div>
            ${meta ? `<p class="font-mono text-[11px] text-ink-mute mt-1">${escapeHtml(meta)}</p>` : ""}
            ${matched}
            <p class="text-[12.5px] text-ink-soft mt-2 leading-relaxed">${escapeHtml(r.reason || "")}</p>
            ${conf}
            <div class="flex items-center gap-4 mt-2.5 flex-wrap">${cited}${exists}${link}</div>
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

  // export CSV
  $("export-btn").addEventListener("click", () => {
    if (!currentResult) return;
    const rows = [["#", "verdict", "confidence", "exists", "cited_in_text", "title", "authors", "year", "journal", "doi", "reason"]];
    currentResult.references.forEach((r, i) =>
      rows.push([i + 1, r.verdict, r.confidence, r.exists, occurrences[r.id] || 0, r.title, r.authors, r.year, r.journal, r.doi, r.reason]));
    const csv = rows.map((row) => row.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = (currentResult.filename || "report").replace(/\.[^.]+$/, "") + "_refcheck.csv";
    a.click(); URL.revokeObjectURL(url);
  });

  // export CSV
  $("export-btn").addEventListener("click", () => {
    if (!currentResult) return;
    const rows = [["#", "verdict", "exists", "title", "authors", "year", "journal", "doi", "reason"]];
    currentResult.references.forEach((r, i) =>
      rows.push([i + 1, r.verdict, r.exists, r.title, r.authors, r.year, r.journal, r.doi, r.reason]));
    const csv = rows.map((row) => row.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = (currentResult.filename || "report").replace(/\.[^.]+$/, "") + "_refcheck.csv";
    a.click(); URL.revokeObjectURL(url);
  });

  // ============================================================
  // History
  // ============================================================
  async function loadHistory() {
    let { data, error } = await sb.from("analyses")
      .select("id, filename, integrity_score, counts, results, document_text, created_at")
      .order("created_at", { ascending: false }).limit(50);
    if (error) {
      // fallback if the document_text column hasn't been added yet
      ({ data, error } = await sb.from("analyses")
        .select("id, filename, integrity_score, counts, results, created_at")
        .order("created_at", { ascending: false }).limit(50));
    }
    if (error || !data) return;
    historyCount.textContent = data.length;
    if (!data.length) { historyEmpty.classList.remove("hidden"); return; }
    historyEmpty.classList.add("hidden");
    historyList.querySelectorAll("[data-hid]").forEach((n) => n.remove());
    data.forEach((row) => {
      const el = document.createElement("button");
      el.setAttribute("data-hid", row.id);
      el.className = "text-left w-full rounded-lg px-3 py-2.5 border border-border-subtle hover:border-border-strong hover:bg-white/[0.03] transition-colors";
      el.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[16px] text-ink-mute shrink-0">description</span>
          <span class="text-xs text-white truncate flex-grow">${escapeHtml(row.filename)}</span>
          <span class="font-mono text-[11px] text-ink-soft shrink-0">${row.integrity_score}</span>
        </div>
        <div class="font-mono text-[10px] text-ink-mute mt-1">${new Date(row.created_at).toLocaleDateString()} · ${row.counts.flagged} flagged</div>`;
      el.addEventListener("click", () => {
        const fullText = row.document_text || "";
        const { bodyEnd } = fullText ? sliceReferences(fullText) : { bodyEnd: 0 };
        currentResult = {
          filename: row.filename, integrityScore: row.integrity_score,
          counts: row.counts, references: row.results, created_at: row.created_at,
          fullText, bodyEnd,
        };
        renderResult(currentResult);
        closeSidebar();
      });
      historyList.appendChild(el);
    });
  }

  $("new-analysis-btn").addEventListener("click", () => {
    currentFile = null; fileInput.value = "";
    fileSelected.classList.add("hidden"); analyzeBtn.disabled = true; setError("");
    showView("upload"); closeSidebar();
  });

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

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();

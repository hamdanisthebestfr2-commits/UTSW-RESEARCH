// ============================================================
// REF/CHECK AI — Admin dashboard
// Gated to ADMIN_EMAILS. Reads all analyses + feedback (admin RLS policies),
// shows usage KPIs, feedback accuracy, per-user counts, and CSV export.
// ============================================================
(function () {
  "use strict";

  const configured = window.SUPABASE_URL && !/YOUR-PROJECT/.test(window.SUPABASE_URL)
    && window.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(window.SUPABASE_ANON_KEY);
  if (!configured || !window.supabase) { location.replace("auth.html"); return; }

  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let feedbackRows = [];

  (async function init() {
    const { data } = await sb.auth.getSession();
    if (!(data && data.session)) { location.replace("auth.html"); return; }
    const email = (data.session.user.email || "").toLowerCase();
    const admins = (window.ADMIN_EMAILS || []).map((e) => e.toLowerCase());
    $("gate").classList.add("hidden");
    if (!admins.includes(email)) { $("denied").classList.remove("hidden"); return; }
    $("admin").classList.remove("hidden");
    load();
  })();

  $("export-fb").addEventListener("click", exportFeedbackCsv);

  function shortUser(id) { return id ? id.slice(0, 8) : "—"; }

  async function load() {
    // analyses (admin RLS lets an admin read all rows)
    const { data: analyses = [], error: aErr } = await sb.from("analyses")
      .select("id, user_id, filename, counts, created_at")
      .order("created_at", { ascending: false });
    // feedback
    const { data: feedback = [], error: fErr } = await sb.from("feedback")
      .select("feature, item_key, rating, comment, user_id, analysis_id, created_at")
      .order("created_at", { ascending: false });
    feedbackRows = feedback || [];

    if (aErr || fErr) {
      $("kpis").innerHTML = `<div class="glass rounded-2xl p-5 col-span-full text-sm text-bad">
        Couldn't load data. Make sure the admin RLS policies and the <code>feedback</code> table exist (see the SQL your assistant provided).</div>`;
    }

    renderKpis(analyses || [], feedbackRows);
    renderAccuracy(feedbackRows);
    renderUsers(analyses || [], feedbackRows);
    renderFeedbackTable(feedbackRows);
  }

  function sumRefs(a) {
    const c = a.counts || {};
    return (c.verified || 0) + (c.review || 0) + (c.flagged || 0);
  }

  function renderKpis(analyses, feedback) {
    const manuscripts = analyses.length;
    const refs = analyses.reduce((s, a) => s + sumRefs(a), 0);
    const verified = analyses.reduce((s, a) => s + ((a.counts && a.counts.verified) || 0), 0);
    const up = feedback.filter((f) => f.rating === "up").length;
    const down = feedback.filter((f) => f.rating === "down").length;
    const pct = up + down ? Math.round((100 * up) / (up + down)) : null;
    const cards = [
      ["Manuscripts checked", manuscripts, "description"],
      ["References verified", `${verified} / ${refs}`, "fact_check"],
      ["Feedback collected", up + down, "thumbs_up_down"],
      ["Thumbs-up rate", pct == null ? "—" : pct + "%", "trending_up"],
    ];
    $("kpis").innerHTML = cards.map(([label, value, icon]) => `
      <div class="glass rounded-2xl p-5">
        <div class="flex items-center gap-2 text-ink-mute mb-2"><span class="material-symbols-outlined text-[18px]">${icon}</span><span class="font-mono text-[10px] uppercase tracking-wider">${label}</span></div>
        <div class="font-display text-2xl text-white">${value}</div>
      </div>`).join("");
  }

  function bar(label, up, down) {
    const total = up + down;
    const pct = total ? Math.round((100 * up) / total) : 0;
    return `<div>
      <div class="flex justify-between text-sm mb-1"><span class="text-ink-soft">${label}</span>
        <span class="font-mono text-xs text-ink-mute">${up}▲ / ${down}▼ ${total ? "· " + pct + "% up" : ""}</span></div>
      <div class="h-2.5 rounded-full overflow-hidden bg-white/5 flex">
        <div class="bg-ok h-full" style="width:${total ? pct : 0}%"></div>
        <div class="bg-bad h-full" style="width:${total ? 100 - pct : 0}%"></div>
      </div>
    </div>`;
  }

  function renderAccuracy(feedback) {
    const by = (feat) => {
      const rows = feature(feedback, feat);
      return [rows.filter((f) => f.rating === "up").length, rows.filter((f) => f.rating === "down").length];
    };
    function feature(arr, f) { return arr.filter((x) => x.feature === f); }
    const [ru, rd] = by("reference");
    const [cu, cd] = by("citation");
    const allUp = feedback.filter((f) => f.rating === "up").length;
    const allDown = feedback.filter((f) => f.rating === "down").length;
    $("accuracy").innerHTML = [
      bar("Overall", allUp, allDown),
      bar("Reference verification", ru, rd),
      bar("Citation checking", cu, cd),
    ].join("");
  }

  function renderUsers(analyses, feedback) {
    const map = {};
    analyses.forEach((a) => {
      const u = a.user_id || "—";
      map[u] = map[u] || { manuscripts: 0, refs: 0, fb: 0 };
      map[u].manuscripts++; map[u].refs += sumRefs(a);
    });
    feedback.forEach((f) => {
      const u = f.user_id || "—";
      map[u] = map[u] || { manuscripts: 0, refs: 0, fb: 0 };
      map[u].fb++;
    });
    const rows = Object.entries(map).sort((a, b) => b[1].manuscripts - a[1].manuscripts);
    const tb = $("users-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map(([u, s]) => `<tr><td class="font-mono text-xs">${esc(shortUser(u))}</td><td>${s.manuscripts}</td><td>${s.refs}</td><td>${s.fb}</td></tr>`).join("")
      : `<tr><td colspan="4" class="text-ink-mute">No data yet.</td></tr>`;
  }

  function renderFeedbackTable(feedback) {
    const tb = $("fb-table").querySelector("tbody");
    const rows = feedback.slice(0, 100);
    tb.innerHTML = rows.length
      ? rows.map((f) => `<tr>
          <td class="font-mono text-xs text-ink-mute">${new Date(f.created_at).toLocaleString()}</td>
          <td>${esc(f.feature)}</td>
          <td>${f.rating === "up" ? '<span class="text-ok">▲ up</span>' : '<span class="text-bad">▼ down</span>'}</td>
          <td class="text-ink-soft">${esc(f.comment || "")}</td>
          <td class="font-mono text-xs">${esc(shortUser(f.user_id))}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="text-ink-mute">No feedback yet.</td></tr>`;
  }

  function exportFeedbackCsv() {
    const header = ["created_at", "feature", "item_key", "rating", "comment", "user_id", "analysis_id"];
    const rows = [header];
    feedbackRows.forEach((f) => rows.push([f.created_at, f.feature, f.item_key, f.rating, f.comment, f.user_id, f.analysis_id]));
    const csv = rows.map((r) => r.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "refcheck_feedback.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
})();

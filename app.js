// ============================================================
// REF-CHECK AI — landing page interactions & scroll animations
// ============================================================
(function () {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- Sticky navbar state on scroll ----
  const navbar = document.getElementById("navbar");
  function onScrollNav() {
    if (window.scrollY > 24) {
      navbar.classList.add("bg-surface-dim/80", "backdrop-blur-md", "shadow-lg", "border-border-subtle");
    } else {
      navbar.classList.remove("bg-surface-dim/80", "backdrop-blur-md", "shadow-lg", "border-border-subtle");
    }
  }
  window.addEventListener("scroll", onScrollNav, { passive: true });
  onScrollNav();

  // ---- Scroll progress bar ----
  const progress = document.getElementById("scroll-progress");
  function onScrollProgress() {
    const h = document.documentElement;
    const scrolled = (h.scrollTop) / (h.scrollHeight - h.clientHeight);
    progress.style.width = (scrolled * 100).toFixed(2) + "%";
  }
  window.addEventListener("scroll", onScrollProgress, { passive: true });
  onScrollProgress();

  // ---- Mobile menu ----
  const menuBtn = document.getElementById("menu-btn");
  const mobileMenu = document.getElementById("mobile-menu");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      mobileMenu.classList.toggle("hidden");
      const icon = menuBtn.querySelector(".material-symbols-outlined");
      icon.textContent = mobileMenu.classList.contains("hidden") ? "menu" : "close";
    });
    mobileMenu.querySelectorAll(".mobile-link").forEach((l) =>
      l.addEventListener("click", () => {
        mobileMenu.classList.add("hidden");
        menuBtn.querySelector(".material-symbols-outlined").textContent = "menu";
      })
    );
  }

  // ---- Scroll reveal (reveal + stagger) ----
  const revealEls = document.querySelectorAll("[data-reveal], [data-stagger]");
  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          if (el.hasAttribute("data-stagger")) {
            Array.from(el.children).forEach((child, i) => {
              child.style.transitionDelay = i * 90 + "ms";
            });
          }
          el.classList.add("is-visible");
          io.unobserve(el);
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  // ---- Count-up stats ----
  function animateCount(el) {
    const target = parseFloat(el.getAttribute("data-count"));
    const suffix = el.getAttribute("data-suffix") || "";
    const dur = 1600;
    const start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = target * eased;
      el.textContent = (target % 1 === 0 ? Math.round(val) : val.toFixed(1)) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  const counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window && !reduceMotion) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { animateCount(e.target); cio.unobserve(e.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach((c) => cio.observe(c));
  } else {
    counters.forEach((c) => (c.textContent = c.getAttribute("data-count") + (c.getAttribute("data-suffix") || "")));
  }

  // ---- Animated progress bar in "How it works" card ----
  const bar = document.querySelector("[data-bar]");
  const barLabel = document.querySelector("[data-bar-label]");
  if (bar) {
    const bio = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        requestAnimationFrame(() => { bar.style.width = "85%"; });
        const start = performance.now();
        function tick(now) {
          const p = Math.min((now - start) / 1500, 1);
          barLabel.textContent = Math.round(85 * (1 - Math.pow(1 - p, 3))) + "%";
          if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        bio.unobserve(e.target);
      });
    }, { threshold: 0.5 });
    bio.observe(bar);
  }

  // ---- Active nav link on scroll ----
  const sections = ["features", "how-it-works", "platform", "verification", "audience"].map((id) => document.getElementById(id)).filter(Boolean);
  const navLinks = document.querySelectorAll(".nav-link");
  function setActive() {
    let current = "";
    const y = window.scrollY + 120;
    sections.forEach((s) => { if (y >= s.offsetTop) current = s.id; });
    navLinks.forEach((l) =>
      l.classList.toggle("active", l.getAttribute("href") === "#" + current)
    );
  }
  window.addEventListener("scroll", setActive, { passive: true });
  setActive();


  // ---- Cursor spotlight (page-wide ambient) ----
  const spotlight = document.getElementById("spotlight");
  if (spotlight && !reduceMotion && window.matchMedia("(pointer:fine)").matches) {
    window.addEventListener("pointermove", (e) => {
      spotlight.style.setProperty("--mx", e.clientX + "px");
      spotlight.style.setProperty("--my", e.clientY + "px");
    }, { passive: true });
  }

  // ---- Spotlight glow cards: track the pointer locally within each card ----
  // (no pointer-type gate — some touch-capable laptops report a coarse primary
  // pointer even with a mouse, which would otherwise freeze the glow)
  document.querySelectorAll(".beam").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      // glow position
      card.style.setProperty("--x", x.toFixed(1));
      card.style.setProperty("--y", y.toFixed(1));
      card.style.setProperty("--xp", (x / r.width).toFixed(3));
      // 3D tilt toward the cursor
      if (!reduceMotion) {
        const rotateY = ((x - r.width / 2) / (r.width / 2)) * 6;
        const rotateX = ((y - r.height / 2) / (r.height / 2)) * -6;
        card.style.transition = "transform 0.1s ease-out";
        card.style.transform =
          "perspective(1000px) rotateX(" + rotateX.toFixed(2) + "deg) rotateY(" +
          rotateY.toFixed(2) + "deg) translateY(-4px)";
      }
    }, { passive: true });
    card.addEventListener("pointerleave", () => {
      card.style.transition = "transform 0.5s ease";
      card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg)";
    });
  });

  // ---- 3D tilt on hero mockup ----
  const tiltEl = document.querySelector("#hero-mockup .tilt");
  if (tiltEl && !reduceMotion && window.matchMedia("(pointer:fine)").matches) {
    const wrap = document.getElementById("hero-mockup");
    wrap.style.perspective = "1200px";
    wrap.addEventListener("pointermove", (e) => {
      const r = wrap.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      tiltEl.style.transform = "rotateY(" + (px * 6).toFixed(2) + "deg) rotateX(" + (-py * 5).toFixed(2) + "deg)";
    }, { passive: true });
    wrap.addEventListener("pointerleave", () => {
      tiltEl.style.transform = "rotateY(0deg) rotateX(0deg)";
    });
  }

  // ---- Platform preview: tab switching ----
  const platformCard = document.getElementById("platform-card");
  if (platformCard) {
    const pTabs = platformCard.querySelectorAll("[data-tab]");
    const pPanels = platformCard.querySelectorAll("[data-panel]");
    const phHeader = platformCard.querySelector("[data-ph-header]");
    const phDesc = platformCard.querySelector("[data-ph-desc]");
    const meta = {
      dashboard: ["ANALYSIS OVERVIEW", "Live summary of your verification runs."],
      references: ["REFERENCE QUEUE", "Statuses across your latest manuscript."],
      sources: ["CONNECTED SOURCES", "Databases cross-referenced on every scan."],
      reports: ["EXPORTS & ARCHIVES", "Download and revisit past integrity reports."],
    };
    function activateTab(id) {
      pTabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === id));
      pPanels.forEach((p) => {
        const on = p.getAttribute("data-panel") === id;
        p.style.display = on ? "" : "none";
        if (on && !reduceMotion) {
          p.classList.remove("panel-anim");
          void p.offsetWidth; // reflow to restart animation
          p.classList.add("panel-anim");
        }
      });
      if (meta[id]) { phHeader.textContent = meta[id][0]; phDesc.textContent = meta[id][1]; }
    }
    pTabs.forEach((t) => t.addEventListener("click", () => activateTab(t.getAttribute("data-tab"))));
  }

  // ---- Hero particle network canvas ----
  const canvas = document.getElementById("hero-canvas");
  if (canvas && !reduceMotion) {
    const ctx = canvas.getContext("2d");
    let w, h, dpr, nodes;
    const COUNT = window.innerWidth < 768 ? 34 : 64;
    const LINK = 130;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.parentElement.getBoundingClientRect();
      w = rect.width; h = rect.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function init() {
      nodes = Array.from({ length: COUNT }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.8 + 0.7,
      }));
    }
    function step() {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fill();
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          const dx = n.x - m.x, dy = n.y - m.y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK) {
            ctx.beginPath();
            ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y);
            ctx.strokeStyle = "rgba(255,255,255," + (0.18 * (1 - dist / LINK)).toFixed(3) + ")";
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(step);
    }
    resize(); init(); step();
    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { resize(); init(); }, 200);
    });
  }
})();

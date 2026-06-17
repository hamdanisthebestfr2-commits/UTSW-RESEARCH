// ============================================================
// REF/CHECK AI — auth page logic (Supabase: email/password + Google)
// ============================================================
(function () {
  "use strict";

  // Surface any uncaught script error directly on the page (so we don't need the console).
  window.addEventListener("error", function (ev) {
    const m = document.getElementById("auth-message");
    if (m) {
      m.textContent = "Error: " + (ev.message || ev.error || "unknown");
      m.className = "text-xs rounded-lg px-3 py-2.5 bg-bad/10 text-bad border border-bad/20";
    }
  });

  const urlOk = window.SUPABASE_URL && !/YOUR-PROJECT/.test(window.SUPABASE_URL);
  const keyOk = window.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(window.SUPABASE_ANON_KEY);
  const configured = urlOk && keyOk;

  // ---- elements ----
  const form = document.getElementById("auth-form");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const submitBtn = document.getElementById("submit-btn");
  const submitLabel = document.getElementById("submit-label");
  const googleBtn = document.getElementById("google-btn");
  const titleEl = document.getElementById("auth-title");
  const subtitleEl = document.getElementById("auth-subtitle");
  const togglePrompt = document.getElementById("toggle-prompt");
  const toggleBtn = document.getElementById("toggle-mode");
  const msg = document.getElementById("auth-message");

  // ---- message helper ----
  function showMessage(text, kind) {
    msg.textContent = text;
    msg.classList.remove("hidden");
    msg.classList.toggle("bg-bad/10", kind === "error");
    msg.classList.toggle("text-bad", kind === "error");
    msg.classList.toggle("border", true);
    msg.classList.toggle("border-bad/20", kind === "error");
    msg.classList.toggle("bg-ok/10", kind === "success");
    msg.classList.toggle("text-ok", kind === "success");
    msg.classList.toggle("border-ok/20", kind === "success");
  }
  function clearMessage() { msg.classList.add("hidden"); }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    googleBtn.disabled = busy;
  }

  // ---- mode (signin | signup) ----
  let mode = new URLSearchParams(location.search).get("mode") === "signup" ? "signup" : "signin";
  function applyMode() {
    const signup = mode === "signup";
    titleEl.textContent = signup ? "Create your account" : "Welcome back";
    subtitleEl.textContent = signup ? "Start verifying references in minutes." : "Sign in to verify your references.";
    submitLabel.textContent = signup ? "Create account" : "Sign in";
    togglePrompt.textContent = signup ? "Already have an account?" : "Don't have an account?";
    toggleBtn.textContent = signup ? "Sign in" : "Create one";
    passwordEl.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    clearMessage();
  }
  toggleBtn.addEventListener("click", () => {
    mode = mode === "signup" ? "signin" : "signup";
    applyMode();
  });
  applyMode();

  // ---- guard: not configured yet ----
  if (!configured) {
    showMessage("Auth isn't connected yet — add your Supabase URL and anon key in supabase-config.js.", "error");
    setBusy(true);
    return;
  }

  // ---- guard: Supabase library failed to load (network / ad-block) ----
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    showMessage("Couldn't load the Supabase library — check your connection or any ad-blocker, then reload.", "error");
    setBusy(true);
    return;
  }

  // ---- Supabase client ----
  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  console.log("[auth] ready — supabase client created for", window.SUPABASE_URL);

  if (window.AUTH_TESTING) {
    // Testing mode: clear any existing session so the login form is always fresh.
    sessionStorage.removeItem("app_seen");
    sb.auth.signOut();
  } else {
    // Already signed in? Go straight to the app.
    sb.auth.getSession().then(({ data }) => {
      if (data && data.session) location.replace(window.AUTH_REDIRECT);
    });
  }

  // ---- email/password submit ----
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMessage();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || password.length < 6) {
      showMessage("Enter a valid email and a password of at least 6 characters.", "error");
      return;
    }
    setBusy(true);
    submitLabel.textContent = mode === "signup" ? "Creating…" : "Signing in…";
    try {
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.AUTH_REDIRECT },
        });
        if (error) throw error;
        if (data.session) {
          location.replace(window.AUTH_REDIRECT);        // email confirmation disabled
        } else {
          showMessage("Check your inbox to confirm your email, then sign in.", "success");
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        location.replace(window.AUTH_REDIRECT);
      }
    } catch (err) {
      showMessage(err.message || "Something went wrong. Please try again.", "error");
    } finally {
      setBusy(false);
      // restore the button label WITHOUT clearing the error message
      submitLabel.textContent = mode === "signup" ? "Create account" : "Sign in";
    }
  });

  // ---- Google OAuth ----
  googleBtn.addEventListener("click", async () => {
    clearMessage();
    setBusy(true);
    try {
      const { error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.AUTH_REDIRECT },
      });
      if (error) throw error;
      // browser redirects to Google on success
    } catch (err) {
      showMessage(err.message || "Google sign-in failed.", "error");
      setBusy(false);
    }
  });
})();

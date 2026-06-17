// ============================================================
// Supabase config.
//   Project ref: emzssipjrkknheomfjem
//   • SUPABASE_URL      → the API URL (https://<ref>.supabase.co), NOT the dashboard URL
//   • SUPABASE_ANON_KEY → publishable/anon public key (safe to expose; RLS protects data)
// ============================================================
window.SUPABASE_URL = "https://emzssipjrkknheomfjem.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_R9s6yZ8vEli2JKVnKSykLg__OOO4_4E";

// Where users land after a successful login (blank placeholder for now).
window.AUTH_REDIRECT = window.location.origin + "/app.html";

// TESTING MODE: when true, reloading any page signs you out so you can keep
// re-testing the login. Now that the real app persists sessions, keep this false.
window.AUTH_TESTING = false;

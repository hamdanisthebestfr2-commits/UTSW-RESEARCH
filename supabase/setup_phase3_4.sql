-- ============================================================
-- REF/CHECK AI — Phase 3 + 4 database setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to re-run: every statement is idempotent or guarded.
-- ============================================================

-- 1) PHASE 3 — store AI citation-checking results on each analysis row
alter table public.analyses add column if not exists citation_results jsonb;

-- 2) PHASE 4 — thumbs up/down feedback on verification + citation results
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  analysis_id uuid references public.analyses(id) on delete cascade,
  feature text not null,            -- 'reference' | 'citation'
  item_key text not null,           -- reference id or citation-instance id
  rating text not null check (rating in ('up','down')),
  comment text,
  created_at timestamptz not null default now()
);

-- one feedback row per user per item (required for the app's upsert)
create unique index if not exists feedback_unique_item
  on public.feedback (user_id, analysis_id, feature, item_key);

alter table public.feedback enable row level security;

do $$ begin
  create policy "fb_own_select" on public.feedback for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "fb_own_insert" on public.feedback for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "fb_own_update" on public.feedback for update using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "fb_own_delete" on public.feedback for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- 3) ADMIN — let admin email(s) read ALL analyses + feedback (for admin.html).
--    EDIT the email list to match window.ADMIN_EMAILS in supabase-config.js
do $$ begin
  create policy "analyses_admin_select" on public.analyses for select
    using ( (auth.jwt() ->> 'email') in ('ibrahimosman123cc@gmail.com') );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "feedback_admin_select" on public.feedback for select
    using ( (auth.jwt() ->> 'email') in ('ibrahimosman123cc@gmail.com') );
exception when duplicate_object then null; end $$;

-- 4) GLOBAL STAT — counts across all users for the "This tool has checked X…" line.
--    security definer so it aggregates without exposing individual rows.
create or replace function public.app_stats()
returns table (manuscripts bigint, references_count bigint)
language sql security definer set search_path = public as $$
  select
    count(*)::bigint as manuscripts,
    coalesce(sum(
      coalesce((counts->>'verified')::int, 0) +
      coalesce((counts->>'review')::int, 0) +
      coalesce((counts->>'flagged')::int, 0)
    ), 0)::bigint as references_count
  from public.analyses;
$$;
grant execute on function public.app_stats() to anon, authenticated;

-- Homework tracker — per-user tasks protected by row-level security.
-- Safe to run more than once.

create extension if not exists pgcrypto;   -- gen_random_uuid()

create table if not exists public.tasks (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject  text not null,
  type     text not null default 'homework'  check (type   in ('homework','assessment')),
  source   text not null default 'school'    check (source in ('school','tuition')),
  text     text not null,
  due      date,
  done     boolean not null default false,
  created  bigint  not null default 0
);

create index if not exists tasks_user_id_idx on public.tasks (user_id);

-- Lock the table down: every request must present a signed-in user's token,
-- and can only ever see or touch its own rows.
alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own" on public.tasks
  for select using (auth.uid() = user_id);

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own" on public.tasks
  for insert with check (auth.uid() = user_id);

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own" on public.tasks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own" on public.tasks
  for delete using (auth.uid() = user_id);


-- Per-user profile: which subjects they take, and whether they've picked yet.
create table if not exists public.profiles (
  id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  subjects   text[]  not null default '{}',
  onboarded  boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Device-agnostic UI preferences (which tab, hide-empty). Added separately so it
-- also applies to profiles tables that were created before this column existed.
alter table public.profiles add column if not exists prefs jsonb not null default '{}'::jsonb;

-- 在 Supabase Dashboard 的 SQL Editor 中运行一次。
-- 此表每位登录用户仅有一条自己的完整档案记录。
create table if not exists public.tutor_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"students":[],"activeId":null}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tutor_profiles enable row level security;

drop policy if exists "Users can read their own tutor profile" on public.tutor_profiles;
create policy "Users can read their own tutor profile"
on public.tutor_profiles for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can create their own tutor profile" on public.tutor_profiles;
create policy "Users can create their own tutor profile"
on public.tutor_profiles for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update their own tutor profile" on public.tutor_profiles;
create policy "Users can update their own tutor profile"
on public.tutor_profiles for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

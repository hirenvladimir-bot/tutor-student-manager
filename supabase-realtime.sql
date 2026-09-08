-- 在 Supabase SQL Editor 中运行一次，为已登录用户的跨设备实时同步启用表变更广播。
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tutor_profiles'
  ) then
    alter publication supabase_realtime add table public.tutor_profiles;
  end if;
end $$;

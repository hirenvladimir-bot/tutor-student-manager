-- 知行 v2：逐记录同步结构。可重复执行；不会删除 tutor_profiles 旧表。
create extension if not exists pgcrypto;

create table if not exists public.students (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '', school text not null default '', target_school text not null default '',
  current_score text, target_score text, next_lesson text not null default '', focus_content text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1, deleted_at timestamptz
);
create table if not exists public.scores (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  label text not null default '', exam_date text not null default '', score numeric not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1, deleted_at timestamptz
);
create table if not exists public.preparations (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  title text not null default '', content text not null default '', record_date text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1, deleted_at timestamptz
);
create table if not exists public.course_progress (like public.preparations including defaults including constraints);
alter table public.course_progress drop constraint if exists course_progress_pkey;
alter table public.course_progress add primary key (id);
alter table public.course_progress drop constraint if exists course_progress_student_id_fkey;
alter table public.course_progress add constraint course_progress_student_id_fkey foreign key (student_id) references public.students(id) on delete cascade;
alter table public.course_progress drop constraint if exists course_progress_user_id_fkey;
alter table public.course_progress add constraint course_progress_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
create table if not exists public.custom_fields (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  field_key text not null default '', field_value text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1, deleted_at timestamptz
);
create table if not exists public.attachments (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  owner_type text not null check (owner_type in ('preparations','course_progress')), owner_id uuid not null,
  name text not null, relative_path text not null default '', mime_type text not null default 'application/octet-stream',
  size bigint not null default 0, storage_path text not null default '', legacy_data text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version bigint not null default 1, deleted_at timestamptz
);
alter table public.attachments add column if not exists legacy_data text not null default '';
create table if not exists public.tutor_migrations (
  user_id uuid primary key references auth.users(id) on delete cascade, schema_version integer not null,
  migrated_at timestamptz not null default now()
);
create table if not exists public.tutor_profile_backups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null, backed_up_at timestamptz not null default now()
);

-- 私有附件桶。对象路径必须以当前登录账号 UUID 开头：user_id/student_id/...
insert into storage.buckets (id,name,public)
values ('tutor-files','tutor-files',false)
on conflict (id) do update set public=false;

drop policy if exists "tutor_files_select_own" on storage.objects;
create policy "tutor_files_select_own" on storage.objects for select to authenticated
using (bucket_id='tutor-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "tutor_files_insert_own" on storage.objects;
create policy "tutor_files_insert_own" on storage.objects for insert to authenticated
with check (bucket_id='tutor-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "tutor_files_update_own" on storage.objects;
create policy "tutor_files_update_own" on storage.objects for update to authenticated
using (bucket_id='tutor-files' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='tutor-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "tutor_files_delete_own" on storage.objects;
create policy "tutor_files_delete_own" on storage.objects for delete to authenticated
using (bucket_id='tutor-files' and (storage.foldername(name))[1]=auth.uid()::text);

do $$ declare t text; begin
  foreach t in array array['students','scores','preparations','course_progress','custom_fields','attachments','tutor_migrations','tutor_profile_backups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "owner_all" on public.%I', t);
    execute format('create policy "owner_all" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;

create or replace function public.tutor_record_json(p_entity text, p_id uuid)
returns jsonb language plpgsql security invoker as $$
declare r jsonb;
begin
  if p_entity = 'students' then select jsonb_build_object('key','students:'||id,'entity','students','id',id,'studentId',null,'data',jsonb_build_object('name',name,'school',school,'targetSchool',target_school,'currentScore',current_score,'targetScore',target_score,'nextLesson',next_lesson,'focusContent',focus_content),'version',version,'deletedAt',deleted_at,'updatedAt',updated_at) into r from public.students where id=p_id and user_id=auth.uid();
  elsif p_entity = 'scores' then select jsonb_build_object('key','scores:'||id,'entity','scores','id',id,'studentId',student_id,'data',jsonb_build_object('label',label,'date',exam_date,'score',score),'version',version,'deletedAt',deleted_at,'updatedAt',updated_at) into r from public.scores where id=p_id and user_id=auth.uid();
  elsif p_entity in ('preparations','course_progress') then execute format('select jsonb_build_object(''key'',%L||'':''||id,''entity'',%L,''id'',id,''studentId'',student_id,''data'',jsonb_build_object(''title'',title,''content'',content,''date'',record_date),''version'',version,''deletedAt'',deleted_at,''updatedAt'',updated_at) from public.%I where id=$1 and user_id=auth.uid()',p_entity,p_entity,p_entity) into r using p_id;
  elsif p_entity = 'custom_fields' then select jsonb_build_object('key','custom_fields:'||id,'entity','custom_fields','id',id,'studentId',student_id,'data',jsonb_build_object('key',field_key,'value',field_value),'version',version,'deletedAt',deleted_at,'updatedAt',updated_at) into r from public.custom_fields where id=p_id and user_id=auth.uid();
  elsif p_entity = 'attachments' then select jsonb_build_object('key','attachments:'||id,'entity','attachments','id',id,'studentId',student_id,'data',jsonb_build_object('ownerType',owner_type,'ownerId',owner_id,'name',name,'relativePath',relative_path,'type',mime_type,'size',size,'path',storage_path,'data',legacy_data,'pending',false,'localBlobKey',''),'version',version,'deletedAt',deleted_at,'updatedAt',updated_at) into r from public.attachments where id=p_id and user_id=auth.uid();
  end if;
  return r;
end $$;

create or replace function public.apply_tutor_mutations(p_mutations jsonb)
returns jsonb language plpgsql security invoker as $$
declare m jsonb; entity text; rid uuid; sid uuid; base bigint; current_version bigint; op text; d jsonb; tbl text; applied jsonb='[]'; conflicts jsonb='[]'; next_version bigint;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  for m in select value from jsonb_array_elements(coalesce(p_mutations,'[]'::jsonb)) loop
    entity:=m->>'entity'; rid:=(m->>'id')::uuid; sid:=nullif(m->>'student_id','')::uuid; base:=coalesce((m->>'base_version')::bigint,0); op:=coalesce(m->>'operation','upsert'); d:=coalesce(m->'data','{}');
    tbl:=case entity when 'students' then 'students' when 'scores' then 'scores' when 'preparations' then 'preparations' when 'course_progress' then 'course_progress' when 'custom_fields' then 'custom_fields' when 'attachments' then 'attachments' end;
    if tbl is null then raise exception 'unknown entity %',entity; end if;
    perform pg_advisory_xact_lock(hashtextextended(entity||rid::text,0));
    execute format('select version from public.%I where id=$1 and user_id=auth.uid()',tbl) into current_version using rid;
    if current_version is distinct from base and not (current_version is null and base=0) then
      conflicts:=conflicts||jsonb_build_array(jsonb_build_object('key',entity||':'||rid,'entity',entity,'id',rid,'cloud',public.tutor_record_json(entity,rid))); continue;
    end if;
    if op='delete' then
      if current_version is null then next_version:=0; else next_version:=current_version+1; execute format('update public.%I set deleted_at=now(),updated_at=now(),version=$2 where id=$1 and user_id=auth.uid()',tbl) using rid,next_version; end if;
    elsif entity='students' then
      insert into public.students(id,user_id,name,school,target_school,current_score,target_score,next_lesson,focus_content,version,deleted_at,updated_at) values(rid,auth.uid(),coalesce(d->>'name',''),coalesce(d->>'school',''),coalesce(d->>'targetSchool',''),d->>'currentScore',d->>'targetScore',coalesce(d->>'nextLesson',''),coalesce(d->>'focusContent',''),coalesce(current_version,0)+1,null,now()) on conflict(id) do update set name=excluded.name,school=excluded.school,target_school=excluded.target_school,current_score=excluded.current_score,target_score=excluded.target_score,next_lesson=excluded.next_lesson,focus_content=excluded.focus_content,version=excluded.version,deleted_at=null,updated_at=now(); next_version:=coalesce(current_version,0)+1;
    elsif entity='scores' then
      insert into public.scores(id,user_id,student_id,label,exam_date,score,version,deleted_at,updated_at) values(rid,auth.uid(),sid,coalesce(d->>'label',''),coalesce(d->>'date',''),(d->>'score')::numeric,coalesce(current_version,0)+1,null,now()) on conflict(id) do update set label=excluded.label,exam_date=excluded.exam_date,score=excluded.score,version=excluded.version,deleted_at=null,updated_at=now(); next_version:=coalesce(current_version,0)+1;
    elsif entity in ('preparations','course_progress') then
      execute format('insert into public.%I(id,user_id,student_id,title,content,record_date,version,deleted_at,updated_at) values($1,auth.uid(),$2,$3,$4,$5,$6,null,now()) on conflict(id) do update set title=excluded.title,content=excluded.content,record_date=excluded.record_date,version=excluded.version,deleted_at=null,updated_at=now()',tbl) using rid,sid,coalesce(d->>'title',''),coalesce(d->>'content',''),coalesce(d->>'date',''),coalesce(current_version,0)+1; next_version:=coalesce(current_version,0)+1;
    elsif entity='custom_fields' then
      insert into public.custom_fields(id,user_id,student_id,field_key,field_value,version,deleted_at,updated_at) values(rid,auth.uid(),sid,coalesce(d->>'key',''),coalesce(d->>'value',''),coalesce(current_version,0)+1,null,now()) on conflict(id) do update set field_key=excluded.field_key,field_value=excluded.field_value,version=excluded.version,deleted_at=null,updated_at=now(); next_version:=coalesce(current_version,0)+1;
    elsif entity='attachments' then
      insert into public.attachments(id,user_id,student_id,owner_type,owner_id,name,relative_path,mime_type,size,storage_path,legacy_data,version,deleted_at,updated_at) values(rid,auth.uid(),sid,d->>'ownerType',(d->>'ownerId')::uuid,coalesce(d->>'name',''),coalesce(d->>'relativePath',''),coalesce(d->>'type','application/octet-stream'),coalesce((d->>'size')::bigint,0),coalesce(d->>'path',''),coalesce(d->>'data',''),coalesce(current_version,0)+1,null,now()) on conflict(id) do update set name=excluded.name,relative_path=excluded.relative_path,mime_type=excluded.mime_type,size=excluded.size,storage_path=excluded.storage_path,legacy_data=excluded.legacy_data,version=excluded.version,deleted_at=null,updated_at=now(); next_version:=coalesce(current_version,0)+1;
    end if;
    applied:=applied||jsonb_build_array(jsonb_build_object('key',entity||':'||rid,'version',next_version,'updated_at',now()));
  end loop;
  return jsonb_build_object('applied',applied,'conflicts',conflicts);
end $$;

-- Helper used by the idempotent legacy migration. It rejects cross-account calls.
create or replace function public.zx_uuid_or_new(p_value text)
returns uuid language plpgsql volatile as $$ begin if p_value is null or btrim(p_value)='' then return gen_random_uuid(); end if; return p_value::uuid; exception when invalid_text_representation then return gen_random_uuid(); end $$;

create or replace function public.migrate_legacy_attachments(p_user uuid,p_student uuid,p_owner_type text,p_owner uuid,p_files jsonb)
returns void language plpgsql security invoker as $$
declare f jsonb; fid uuid;
begin
  if auth.uid() is null or p_user <> auth.uid() then raise exception 'authentication required'; end if;
  for f in select value from jsonb_array_elements(coalesce(p_files,'[]')) loop
    fid:=public.zx_uuid_or_new(f->>'id');
    insert into public.attachments(id,user_id,student_id,owner_type,owner_id,name,relative_path,mime_type,size,storage_path,legacy_data)
    values(fid,p_user,p_student,p_owner_type,p_owner,coalesce(f->>'name','未命名文件'),coalesce(f->>'relativePath',''),coalesce(f->>'type','application/octet-stream'),coalesce((f->>'size')::bigint,0),coalesce(f->>'path',''),coalesce(f->>'data','')) on conflict(id) do nothing;
  end loop;
end $$;
revoke all on function public.migrate_legacy_attachments(uuid,uuid,text,uuid,jsonb) from public;
grant execute on function public.migrate_legacy_attachments(uuid,uuid,text,uuid,jsonb) to authenticated;

create or replace function public.migrate_legacy_tutor_profile()
returns jsonb language plpgsql security invoker as $$
declare profile jsonb; s jsonb; x jsonb; sid uuid; xid uuid; prep_id uuid; counts jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if exists(select 1 from public.tutor_migrations where user_id=auth.uid() and schema_version>=2) then return jsonb_build_object('status','already_migrated'); end if;
  select data into profile from public.tutor_profiles where user_id=auth.uid();
  if profile is not null then insert into public.tutor_profile_backups(user_id,data) values(auth.uid(),profile) on conflict(user_id) do nothing; end if;
  for s in select value from jsonb_array_elements(coalesce(profile->'students','[]')) loop
    sid:=public.zx_uuid_or_new(s->>'id');
    insert into public.students(id,user_id,name,school,target_school,current_score,target_score,next_lesson,focus_content) values(sid,auth.uid(),coalesce(s->>'name',''),coalesce(s->>'school',''),coalesce(s->>'targetSchool',''),s->>'currentScore',s->>'targetScore',coalesce(s->>'nextLesson',''),coalesce(s->>'focusContent','')) on conflict(id) do nothing;
    for x in select value from jsonb_array_elements(coalesce(s->'scores','[]')) loop xid:=public.zx_uuid_or_new(x->>'id'); insert into public.scores(id,user_id,student_id,label,exam_date,score) values(xid,auth.uid(),sid,coalesce(x->>'label',''),coalesce(x->>'date',''),coalesce((x->>'score')::numeric,0)) on conflict(id) do nothing; end loop;
    for x in select value from jsonb_array_elements(coalesce(s->'custom','[]')) loop xid:=public.zx_uuid_or_new(x->>'id'); insert into public.custom_fields(id,user_id,student_id,field_key,field_value) values(xid,auth.uid(),sid,coalesce(x->>'key',''),coalesce(x->>'value','')) on conflict(id) do nothing; end loop;
    for x in select value from jsonb_array_elements(coalesce(s->'preparations','[]')) loop prep_id:=public.zx_uuid_or_new(x->>'id'); insert into public.preparations(id,user_id,student_id,title,content,record_date) values(prep_id,auth.uid(),sid,coalesce(x->>'title',''),coalesce(x->>'content',''),coalesce(x->>'date','')) on conflict(id) do nothing; perform public.migrate_legacy_attachments(auth.uid(),sid,'preparations',prep_id,x->'files'); end loop;
    for x in select value from jsonb_array_elements(coalesce(s->'courseProgress','[]')) loop prep_id:=public.zx_uuid_or_new(x->>'id'); insert into public.course_progress(id,user_id,student_id,title,content,record_date) values(prep_id,auth.uid(),sid,coalesce(x->>'title',coalesce(x->>'text','')),coalesce(x->>'content',''),coalesce(x->>'date','')) on conflict(id) do nothing; perform public.migrate_legacy_attachments(auth.uid(),sid,'course_progress',prep_id,x->'files'); end loop;
  end loop;
  insert into public.tutor_migrations(user_id,schema_version) values(auth.uid(),2) on conflict(user_id) do update set schema_version=2,migrated_at=now();
  select jsonb_build_object('students',(select count(*) from public.students where user_id=auth.uid()),'scores',(select count(*) from public.scores where user_id=auth.uid()),'preparations',(select count(*) from public.preparations where user_id=auth.uid()),'courseProgress',(select count(*) from public.course_progress where user_id=auth.uid()),'attachments',(select count(*) from public.attachments where user_id=auth.uid())) into counts; return counts;
end $$;

grant execute on function public.apply_tutor_mutations(jsonb) to authenticated;
grant execute on function public.migrate_legacy_tutor_profile() to authenticated;
grant execute on function public.tutor_record_json(text,uuid) to authenticated;
grant select,insert,update,delete on public.students,public.scores,public.preparations,public.course_progress,public.custom_fields,public.attachments,public.tutor_migrations,public.tutor_profile_backups to authenticated;

do $$ declare t text; begin foreach t in array array['students','scores','preparations','course_progress','custom_fields','attachments'] loop if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I',t); end if; end loop; end $$;

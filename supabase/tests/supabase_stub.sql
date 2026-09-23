-- Supabase 相当の最小環境
-- ロールは既に存在する場合がある
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;

create schema auth;
create table auth.users (id uuid primary key);

-- 本物は JWT クレームから引くが、テストでは GUC で差し替える
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.uid', true), '')::uuid $$;

create publication supabase_realtime;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- Storage の最小 stub。
-- 本物の storage.foldername はファイル名を除いたパス要素を返すので、
-- 'uid/front.jpg' → {uid} になる。同じ挙動を作る。
create schema storage;

create table storage.buckets (
  id         text primary key,
  name       text not null,
  public     boolean not null default false,
  created_at timestamptz not null default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

create function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

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

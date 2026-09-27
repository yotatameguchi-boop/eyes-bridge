\set ON_ERROR_STOP on
\pset pager off

-- 外から触れる範囲を固定する（0015_lock_down_functions.sql）。
--
-- セキュリティチェックで、ログインしていない人が内部用の関数を呼べると分かった。
-- 関数や表を足すときに権限を付け忘れても、ここで落ちるようにする。
-- 一覧を変えるときは、本当に外から呼ばせてよいかを考えてから直すこと。

create or replace function t_expect(p_cond boolean, p_label text)
returns text language sql as $$ select case when p_cond then 'PASS  ' else 'FAIL  ' end || p_label $$;

-- テスト用の補助関数（t_ で始まる）は、どの役割からでも呼べるようにする。
-- 本番の関数は 0015 で「許したものだけ」にしてあるので、ここで付けるのは補助関数だけ
do $grant$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 't\_%' loop
    execute format('grant execute on function %s to public', f);
  end loop;
end $grant$;


\echo '--- 1. 関数 ---'
select t_expect(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname not like 't\_%'
       and has_function_privilege('anon', p.oid, 'execute')
  ),
  'ログインしていない人は、公開している関数を1つも実行できない');

-- 実行できる関数が一覧と違ったら、何が違うかを出して落とす
with allowed(name) as (values
  ('agree_to_terms'), ('claim_help_request'), ('consume_ocr_quota'), ('end_help_request'),
  ('handle_report'), ('mark_request_rung'), ('my_missing_consents'), ('reconsent'),
  ('register_role'), ('report_participant'), ('review_identity'), ('review_volunteer'),
  ('set_user_blocked'), ('submit_identity')
), actual as (
  select p.proname as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and p.proname not like 't\_%'
     and has_function_privilege('authenticated', p.oid, 'execute')
)
select t_expect(
  not exists (select name from actual except select name from allowed)
    and not exists (select name from allowed except select name from actual),
  'ログインした利用者が実行できるのは、アプリが使う14の関数だけ'
  || coalesce(' （余計: ' || (select string_agg(name, ', ') from (select name from actual except select name from allowed) x) || '）', '')
  || coalesce(' （足りない: ' || (select string_agg(name, ', ') from (select name from allowed except select name from actual) y) || '）', ''));

select t_expect(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('is_admin', 'is_approved_volunteer', 'blocked_between', 'has_current_consents')) = 4
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_admin', 'is_approved_volunteer', 'blocked_between', 'has_current_consents')),
  '権限の判定に使う関数は、API に出ない private スキーマにある');

select t_expect(
  not has_function_privilege('authenticated', 'public.expire_stale_requests(interval)', 'execute')
  and not has_function_privilege('authenticated', 'public.identity_documents_to_purge()', 'execute')
  and not has_function_privilege('authenticated', 'public.mark_identity_purged(uuid)', 'execute'),
  '依頼を全部時間切れにする関数・書類の保存場所を返す関数・参照を消す関数は、ログインしても呼べない');

select t_expect(
  has_function_privilege('service_role', 'public.expire_stale_requests(interval)', 'execute')
  and has_function_privilege('service_role', 'public.identity_documents_to_purge()', 'execute'),
  '定期実行と Edge Function が使うものは、service role からは呼べる');

\echo '--- 2. 表 ---'
select t_expect(
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),
  'すべての表で、行ごとの権限（RLS）が有効'
  || coalesce(' （無効: ' || (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) || '）', ''));

-- データを入れた状態で、ログインしていない人から何も読めないことを確かめる
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000f0001');
insert into profiles (id, role, display_name) values ('00000000-0000-0000-0000-0000000f0001', 'requester', 'R');
insert into help_requests (requester_id) values ('00000000-0000-0000-0000-0000000f0001');

create or replace function t_anon_can_read_nothing() returns text language plpgsql as $$
declare
  t    text;
  n    bigint;
  seen text[] := '{}';
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by 1
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then seen := seen || t; end if;
    exception when insufficient_privilege then
      null;  -- 読めない（権限が無い）のは望ましい
    end;
  end loop;
  return case when cardinality(seen) = 0
    then 'PASS  ログインしていない人は、どの表からも1行も読めない'
    else 'FAIL  ログインしていない人が読める表がある: ' || array_to_string(seen, ', ') end;
end $$;

grant execute on function t_anon_can_read_nothing() to public;
set role anon;
select t_anon_can_read_nothing();
reset role;

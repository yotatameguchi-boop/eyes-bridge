\set ON_ERROR_STOP on
\pset pager off

-- 運営権限と自動チェックまわり。

create or replace function t_expect_error(p_sql text, p_want text, p_label text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return format('FAIL  %s  （通ってしまった）', p_label);
exception when others then
  if position(p_want in sqlerrm) > 0 then
    return format('PASS  %s', p_label);
  end if;
  return format('FAIL  %s  期待=%s 実際=%s', p_label, p_want, sqlerrm);
end $$;

create or replace function t_expect(p_cond boolean, p_label text)
returns text language sql as $$ select case when p_cond then 'PASS  ' else 'FAIL  ' end || p_label $$;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000f1'),  -- 一般ボラ X1
  ('00000000-0000-0000-0000-0000000000f2'),  -- 一般ボラ X2
  ('00000000-0000-0000-0000-0000000000f9');  -- 運営 C

insert into profiles (id, role, display_name, is_admin) values
  ('00000000-0000-0000-0000-0000000000f1','volunteer','X1', false),
  ('00000000-0000-0000-0000-0000000000f2','volunteer','X2', false),
  ('00000000-0000-0000-0000-0000000000f9','volunteer','C',  true);

-- 同意の記録（0010_consents.sql）。この後のテストは同意済みの利用者として動かす。
-- 同意そのものの確認は consent_test.sql
insert into consents (user_id, document, version)
select p.id, d, current_consent_version(d)
  from profiles p cross join unnest(array['terms', 'privacy', 'sensitive']) as d
on conflict do nothing;

insert into volunteer_status (user_id) values
  ('00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000f2'),
  ('00000000-0000-0000-0000-0000000000f9');

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select submit_identity('drivers_license',
  '00000000-0000-0000-0000-0000000000f1/front.jpg',
  '00000000-0000-0000-0000-0000000000f1/selfie.jpg', null);
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f2"}';
select submit_identity('drivers_license',
  '00000000-0000-0000-0000-0000000000f2/front.jpg',
  '00000000-0000-0000-0000-0000000000f2/selfie.jpg', null);

\echo '--- 1. 運営だけが全体を見られる ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select t_expect((select count(*) from profiles) = 1, '一般ユーザーには自分のプロフィールだけ');
select t_expect((select count(*) from volunteer_status) = 1, '一般ユーザーには自分の待機状態だけ');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f9"}';
select t_expect((select count(*) from profiles) >= 3, '運営は全員のプロフィールを見られる');
select t_expect((select count(*) from volunteer_status) >= 3, '運営は全員の待機状態を見られる');
select t_expect((select count(*) from identity_verifications) = 2, '運営は全件の本人確認を見られる');

\echo '--- 2. 自動チェックは service role しか書けない ---'
select t_expect_error(
  $q$select record_document_check(
      (select id from identity_verifications limit 1), null, '{}'::text[], '{}'::jsonb)$q$,
  'permission denied', '運営でも自動チェックを直接書けない');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select t_expect_error(
  $q$insert into document_checks (verification_id, flags)
     values ((select id from identity_verifications limit 1), '{}')$q$,
  'row-level security', '本人も自動チェックを書けない');

\echo '--- 3. 同じ書類の使い回しを見つける ---'
set role service_role;
-- X1 の書類にハッシュを付ける
select record_document_check(
  (select id from identity_verifications where user_id = '00000000-0000-0000-0000-0000000000f1'),
  repeat('0', 32) || repeat('1', 32), '{}'::text[], '{"note":"first"}'::jsonb);

-- X2 が、1ビットだけ違う（＝ほぼ同じ）書類を出してきた
with checked as (
  select record_document_check(
    (select id from identity_verifications where user_id = '00000000-0000-0000-0000-0000000000f2'),
    repeat('0', 31) || '1' || repeat('1', 31) || '0', '{}'::text[], '{}'::jsonb) as flags
)
select t_expect('duplicate_document' = any(flags),
  '別アカウントのほぼ同じ書類に duplicate_document が立つ') from checked;

-- まったく別の書類では立たない
with checked as (
  select record_document_check(
    (select id from identity_verifications where user_id = '00000000-0000-0000-0000-0000000000f2'),
    repeat('01', 32), '{}'::text[], '{}'::jsonb) as flags
)
select t_expect(not ('duplicate_document' = any(flags)),
  '別物の書類では duplicate_document が立たない') from checked;

\echo '--- 4. 自動チェックの見える範囲 ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1"}';
select t_expect((select count(*) from document_checks) = 1, '本人は自分の自動チェックを見られる');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f9"}';
select t_expect((select count(*) from document_checks) = 2, '運営は全件の自動チェックを見られる');

\echo '--- 5. 通報の処理は運営だけ ---'
set role postgres;
insert into help_requests (id, requester_id, volunteer_id, state)
     values ('bbbb0001-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-0000000000f2',
             '00000000-0000-0000-0000-0000000000f1', 'active');
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f2"}';
select report_participant('bbbb0001-0000-0000-0000-000000000001', 'privacy', '', false);
select t_expect_error(
  $q$select handle_report((select id from reports limit 1))$q$,
  'NOT_AN_ADMIN', '一般ユーザーは通報を処理済みにできない');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f9"}';
select t_expect((select count(*) from reports) = 1, '運営は通報を見られる');
select handle_report((select id from reports limit 1));
select t_expect((select handled_at is not null from reports limit 1), '運営は通報を処理済みにできる');
reset role;

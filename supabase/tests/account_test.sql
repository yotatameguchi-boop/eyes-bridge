\set ON_ERROR_STOP on
\pset pager off

-- 退会（0012_account_deletion.sql）。消すものは消し、再登録の防止に要る2つだけ残す。

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
  ('00000000-0000-0000-0000-0000000d0001'),  -- 止められたボランティア S
  ('00000000-0000-0000-0000-0000000d0002'),  -- 普通に退会するボランティア N
  ('00000000-0000-0000-0000-0000000d0003'),  -- 後から同じ書類で登録する人 S2
  ('00000000-0000-0000-0000-0000000d0004');  -- 後から同じ書類で登録する人 N2

insert into profiles (id, role, display_name) values
  ('00000000-0000-0000-0000-0000000d0001', 'volunteer', 'S'),
  ('00000000-0000-0000-0000-0000000d0002', 'volunteer', 'N'),
  ('00000000-0000-0000-0000-0000000d0003', 'volunteer', 'S2'),
  ('00000000-0000-0000-0000-0000000d0004', 'volunteer', 'N2');

insert into volunteer_status (user_id, review_state) values
  ('00000000-0000-0000-0000-0000000d0001', 'suspended'),
  ('00000000-0000-0000-0000-0000000d0002', 'approved'),
  ('00000000-0000-0000-0000-0000000d0003', 'pending'),
  ('00000000-0000-0000-0000-0000000d0004', 'pending');

insert into identity_verifications (id, user_id, kind, front_path, selfie_path) values
  ('d0000001-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000d0001', 'drivers_license', 'a', 'b'),
  ('d0000002-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000d0002', 'drivers_license', 'a', 'b'),
  ('d0000003-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000d0003', 'drivers_license', 'a', 'b'),
  ('d0000004-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000d0004', 'drivers_license', 'a', 'b');

set role service_role;
select record_document_check('d0000001-0000-0000-0000-000000000001', 'fp-suspended', '{}', '{}');
select record_document_check('d0000002-0000-0000-0000-000000000002', 'fp-normal', '{}', '{}');

\echo '--- 1. 退会の前に、識別子と「止められていたか」だけを控える ---'
select t_expect(retire_account('00000000-0000-0000-0000-0000000d0001') = 1, '止められていた人の識別子を控える');
select t_expect(retire_account('00000000-0000-0000-0000-0000000d0002') = 1, '普通に退会する人の識別子も控える');
select t_expect((select was_suspended from retired_fingerprints where fingerprint = 'fp-suspended'),
  '止められていたことが残る');
select t_expect(not (select was_suspended from retired_fingerprints where fingerprint = 'fp-normal'),
  '止められていなかった人は、そう記録される');
select t_expect(
  (select count(*) from information_schema.columns
    where table_name = 'retired_fingerprints'
      and column_name in ('user_id', 'email', 'display_name')) = 0,
  '控えには、誰だったかが分かる列が無い');

-- 退会（auth.users を消すと cascade で消える）
reset role;
delete from auth.users where id in ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0002');
select t_expect(not exists (select 1 from profiles where id in
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0002')), '役割（プロフィール）が消える');
select t_expect(not exists (select 1 from identity_verifications where user_id in
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0002')), '本人確認の記録が消える');
select t_expect(not exists (select 1 from document_checks where verification_id in
  ('d0000001-0000-0000-0000-000000000001', 'd0000002-0000-0000-0000-000000000002')), '自動チェックの記録も消える');
select t_expect(
  (select count(*) from retired_fingerprints where fingerprint in ('fp-suspended', 'fp-normal')) = 2,
  '控えた識別子だけは残る');

\echo '--- 2. 退会した人の書類で作り直すと、運営に分かる ---'
set role service_role;
with checked as (
  select record_document_check('d0000003-0000-0000-0000-000000000003', 'fp-suspended', '{}', '{}') as flags
)
select t_expect('from_suspended_account' = any(flags),
  '止められていた人の書類で作り直すと from_suspended_account が立つ') from checked;
with checked as (
  select record_document_check('d0000004-0000-0000-0000-000000000004', 'fp-normal', '{}', '{}') as flags
)
select t_expect('reused_after_deletion' = any(flags) and not ('from_suspended_account' = any(flags)),
  '普通に退会した人の書類なら reused_after_deletion（止められていた扱いにはしない）') from checked;

\echo '--- 3. 利用者からは触れない ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d0003"}';
select t_expect_error($q$select count(*) from retired_fingerprints$q$, 'permission denied',
  '控えた識別子は利用者から読めない');
select t_expect_error($q$select retire_account(auth.uid())$q$, 'permission denied',
  '退会の前処理を利用者が直接呼べない');
reset role;

\set ON_ERROR_STOP on
\pset pager off

-- 同意（0010_consents.sql）。要配慮個人情報は同意の後でしか取得できないこと。

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

create or replace function t_expect_ok(p_sql text, p_label text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return format('PASS  %s', p_label);
exception when others then
  return format('FAIL  %s  （失敗した: %s）', p_label, sqlerrm);
end $$;

create or replace function t_expect(p_cond boolean, p_label text)
returns text language sql as $$ select case when p_cond then 'PASS  ' else 'FAIL  ' end || p_label $$;

-- 登場人物はまだ profiles を持たない（登録はこれから）
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000c0001'),  -- 依頼者になる人 R
  ('00000000-0000-0000-0000-0000000c0002'),  -- ボランティアになる人 V
  ('00000000-0000-0000-0000-0000000c0003'),  -- 他人 X
  ('00000000-0000-0000-0000-0000000c0009');  -- 運営 A

insert into profiles (id, role, display_name, is_admin)
     values ('00000000-0000-0000-0000-0000000c0009', 'volunteer', 'A', true);

\echo '--- 1. 要配慮個人情報は、同意が無ければ取得しない ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0001"}';

select t_expect_error(
  $q$select register_role('requester', 'R', '2026-09-26', '2026-09-26', null)$q$,
  'SENSITIVE_CONSENT_REQUIRED', '要配慮個人情報への同意が無いと、依頼者として登録できない');
select t_expect(not exists (select 1 from profiles where id = auth.uid()),
  '断られたとき、役割（＝障害の可能性を示す情報）は保存されていない');

select t_expect_error(
  $q$select register_role('requester', 'R', '2025-01-01', '2026-09-26', '2026-09-26')$q$,
  'CONSENT_VERSION_MISMATCH', '古い版の規約への同意では登録できない（読んでいない版に同意したことにしない）');

select t_expect_error(
  $q$insert into profiles (id, role, display_name) values (auth.uid(), 'requester', 'R')$q$,
  'permission denied', '同意を通さずに、役割を直接書き込めない');

select t_expect_ok(
  $q$select register_role('requester', 'R', '2026-09-26', '2026-09-26', '2026-09-26')$q$,
  '3つすべてに同意すれば、依頼者として登録できる');
select t_expect((select role from profiles where id = auth.uid()) = 'requester', '役割が保存される');
select t_expect((select count(*) from consents where user_id = auth.uid()) = 3,
  '同意の記録が3つ（規約・プライバシー・要配慮個人情報）残る');
select t_expect(my_missing_consents() = '{}', '足りない同意は無い');

\echo '--- 2. 同意の記録は改ざんできない ---'
select t_expect_error(
  $q$insert into consents (user_id, document, version) values (auth.uid(), 'terms', '2099-01-01')$q$,
  'permission denied', '同意の記録を直接書き込めない');
select t_expect_error(
  $q$delete from consents where user_id = auth.uid()$q$,
  'permission denied', '同意の記録を消せない');
select t_expect_error(
  $q$update profiles set role = 'volunteer' where id = auth.uid()$q$,
  'permission denied', '役割を直接書き換えられない');
select t_expect_ok(
  $q$update profiles set display_name = '見本' where id = auth.uid()$q$,
  '表示名は自分で変えられる');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0003"}';
select t_expect((select count(*) from consents) = 0, '他人の同意の記録は見えない');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0009"}';
select t_expect((select count(*) from consents) >= 3, '運営は同意の記録を見られる（開示の請求に答えるため）');

\echo '--- 3. 文書の版が上がったら、同意し直すまで依頼できない ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0001"}';
select t_expect_ok(
  $q$insert into help_requests (id, requester_id) values ('c0000001-0000-0000-0000-000000000001', auth.uid())$q$,
  '同意が揃っていれば依頼を立てられる');
select end_help_request('c0000001-0000-0000-0000-000000000001', 'cancelled');

-- 規約が改められた状態を作る（今の版の同意の記録が無い）
reset role;
delete from consents
 where user_id = '00000000-0000-0000-0000-0000000c0001' and document = 'terms';
set role authenticated;

select t_expect(my_missing_consents() = '{terms}', 'アプリは「規約に同意し直す必要がある」と分かる');
select t_expect_error(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  'CONSENT_REQUIRED', '同意し直すまで依頼を立てられない');
select t_expect_ok(
  $q$select reconsent('2026-09-26', '2026-09-26', '2026-09-26')$q$, '同意し直せる');
select t_expect((select role from profiles where id = auth.uid()) = 'requester',
  '同意し直しても役割は変わらない');
select t_expect_ok(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  '同意し直せば、また依頼を立てられる');

\echo '--- 4. ボランティアには要配慮個人情報の同意は要らない ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0002"}';
select t_expect_ok(
  $q$select register_role('volunteer', 'V', '2026-09-26', '2026-09-26', null)$q$,
  'ボランティアは規約とプライバシーポリシーへの同意だけで登録できる');
select t_expect(exists (select 1 from volunteer_status where user_id = auth.uid()),
  'ボランティアの待機状態も一緒に作られる');
select t_expect(my_missing_consents() = '{}', 'ボランティアに足りない同意は無い');

-- 承認済みにしても、同意が今の版でなければ待機列に入れない
reset role;
insert into identity_verifications (user_id, kind, front_path, selfie_path, state)
     values ('00000000-0000-0000-0000-0000000c0002', 'drivers_license', 'x', 'y', 'approved');
update volunteer_status
   set review_state = 'approved', agreed_to_terms_at = now()
 where user_id = '00000000-0000-0000-0000-0000000c0002';
select t_expect(is_approved_volunteer('00000000-0000-0000-0000-0000000c0002'),
  '（準備）同意も審査も揃ったボランティアは待機列に入れる');
delete from consents
 where user_id = '00000000-0000-0000-0000-0000000c0002' and document = 'privacy';
select t_expect(not is_approved_volunteer('00000000-0000-0000-0000-0000000c0002'),
  'プライバシーポリシーが改められたら、同意し直すまで待機列に入れない');

\echo '--- 5. 依頼者に変えるときは、要配慮個人情報の同意が要る ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0002"}';
select t_expect_error(
  $q$select register_role('requester', 'V', '2026-09-26', '2026-09-26', null)$q$,
  'SENSITIVE_CONSENT_REQUIRED', 'ボランティアから依頼者に変えるときも、同意が無ければ断る');
select t_expect((select role from profiles where id = auth.uid()) = 'volunteer',
  '断られたら役割は変わらない');
reset role;

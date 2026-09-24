\set ON_ERROR_STOP on
\pset pager off

-- 悪用を塞いだことの確認（0009_abuse_limits.sql）。

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

-- 登場人物
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000aa01'),  -- 依頼者 P1
  ('00000000-0000-0000-0000-00000000aa02'),  -- 悪質な依頼者 P2
  ('00000000-0000-0000-0000-00000000aa03'),  -- 依頼者 P3（上限の確認用）
  ('00000000-0000-0000-0000-00000000bb01'),  -- ボラ W1
  ('00000000-0000-0000-0000-00000000bb02'),  -- ボラ W2
  ('00000000-0000-0000-0000-00000000bb03'),  -- ボラ W3
  ('00000000-0000-0000-0000-00000000cc01');  -- 運営 A

insert into profiles (id, role, display_name, is_admin) values
  ('00000000-0000-0000-0000-00000000aa01', 'requester', 'P1', false),
  ('00000000-0000-0000-0000-00000000aa02', 'requester', 'P2', false),
  ('00000000-0000-0000-0000-00000000aa03', 'requester', 'P3', false),
  ('00000000-0000-0000-0000-00000000bb01', 'volunteer', 'W1', false),
  ('00000000-0000-0000-0000-00000000bb02', 'volunteer', 'W2', false),
  ('00000000-0000-0000-0000-00000000bb03', 'volunteer', 'W3', false),
  ('00000000-0000-0000-0000-00000000cc01', 'volunteer', 'A',  true);

\echo '--- 1. 依頼の表を直接書き換えられない ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aa01"}';

select t_expect_error(
  $q$insert into help_requests (requester_id, created_at)
     values (auth.uid(), now() - interval '1 day')$q$,
  'permission denied', '作成時刻を過去にずらして立てられない（上限のすり抜けを防ぐ）');
select t_expect_error(
  $q$insert into help_requests (requester_id, room_name) values (auth.uid(), 'room_guessed')$q$,
  'permission denied', '部屋名を自分で決められない');
select t_expect_error(
  $q$insert into help_requests (requester_id, state) values (auth.uid(), 'active')$q$,
  'permission denied', '状態を自分で決められない');

insert into help_requests (id, requester_id) values ('dddd0001-0000-0000-0000-000000000001', auth.uid());
select t_expect_error(
  $q$update help_requests set state = 'queued', volunteer_id = null
      where id = 'dddd0001-0000-0000-0000-000000000001'$q$,
  'permission denied', '自分の依頼でも直接は書き換えられない（状態の変化は RPC だけ）');
select t_expect_error(
  $q$delete from help_requests where id = 'dddd0001-0000-0000-0000-000000000001'$q$,
  'permission denied', '自分の依頼でも消せない（記録を残す）');

\echo '--- 2. 未処理の依頼は1人1件 ---'
select t_expect_error(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  'REQUEST_ALREADY_OPEN', '待っている依頼があるうちは次を立てられない');
select end_help_request('dddd0001-0000-0000-0000-000000000001', 'cancelled');
select t_expect_ok(
  $q$insert into help_requests (id, requester_id) values ('dddd0002-0000-0000-0000-000000000002', auth.uid())$q$,
  '取り下げれば次を立てられる');

-- アプリが落ちて終了の処理が漏れた依頼は、時間が経てば数えない
reset role;
update help_requests set created_at = now() - interval '5 minutes'
 where id = 'dddd0002-0000-0000-0000-000000000002';
set role authenticated;
select t_expect_ok(
  $q$insert into help_requests (id, requester_id) values ('dddd0003-0000-0000-0000-000000000003', auth.uid())$q$,
  '時間切れの依頼が残っていても、次を立てられる（落ちたあと閉じ込めない）');

\echo '--- 3. 着信は1依頼につき1回 ---'
select t_expect(mark_request_rung('dddd0003-0000-0000-0000-000000000003'), '最初の着信は送れる');
select t_expect(not mark_request_rung('dddd0003-0000-0000-0000-000000000003'), '同じ依頼で2回目は送れない');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb01"}';
reset role;
insert into help_requests (id, requester_id)
     values ('dddd0004-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000aa03');
set role authenticated;
select t_expect(not mark_request_rung('dddd0004-0000-0000-0000-000000000004'), '他人の依頼で着信は送れない');

\echo '--- 4. 依頼の数の上限 ---'
-- P3：10分に6件まで。立てては取り下げるを繰り返して7件目で止まるか
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aa03"}';
reset role;
delete from help_requests where requester_id = '00000000-0000-0000-0000-00000000aa03';
set role authenticated;
insert into help_requests (id, requester_id) values ('eeee0001-0000-0000-0000-000000000001', auth.uid());
select end_help_request('eeee0001-0000-0000-0000-000000000001', 'cancelled');
insert into help_requests (id, requester_id) values ('eeee0002-0000-0000-0000-000000000002', auth.uid());
select end_help_request('eeee0002-0000-0000-0000-000000000002', 'cancelled');
insert into help_requests (id, requester_id) values ('eeee0003-0000-0000-0000-000000000003', auth.uid());
select end_help_request('eeee0003-0000-0000-0000-000000000003', 'cancelled');
insert into help_requests (id, requester_id) values ('eeee0004-0000-0000-0000-000000000004', auth.uid());
select end_help_request('eeee0004-0000-0000-0000-000000000004', 'cancelled');
insert into help_requests (id, requester_id) values ('eeee0005-0000-0000-0000-000000000005', auth.uid());
select end_help_request('eeee0005-0000-0000-0000-000000000005', 'cancelled');
select t_expect_ok(
  $q$insert into help_requests (id, requester_id) values ('eeee0006-0000-0000-0000-000000000006', auth.uid())$q$,
  '10分に6件までは立てられる');
select end_help_request('eeee0006-0000-0000-0000-000000000006', 'cancelled');
select t_expect_error(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  'RATE_LIMITED', '10分に7件目は止まる（着信の連打を防ぐ）');

-- 1日40件まで（10分の枠は外して確かめる）
reset role;
update help_requests set created_at = now() - interval '1 hour'
 where requester_id = '00000000-0000-0000-0000-00000000aa03';
insert into help_requests (requester_id, state, created_at)
select '00000000-0000-0000-0000-00000000aa03', 'cancelled', now() - interval '2 hours'
  from generate_series(1, 34);
set role authenticated;
select t_expect(
  (select count(*) from help_requests
    where requester_id = auth.uid() and created_at > now() - interval '24 hours') = 40,
  '（準備）直近24時間に40件ある');
select t_expect_error(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  'RATE_LIMITED', '1日に41件目は止まる');

-- サーバ側（運営・service role）からの登録は縛らない
reset role;
select t_expect_ok(
  $q$insert into help_requests (requester_id) values ('00000000-0000-0000-0000-00000000aa03')$q$,
  '運営側からの登録には上限を掛けない');

\echo '--- 5. 悪質な依頼者は、通報が重なれば止まる ---'
-- P2 と W1〜W3 の通話を3件作り、3人それぞれから通報される
insert into help_requests (id, requester_id, volunteer_id, state) values
  ('ffff0001-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000bb01', 'completed'),
  ('ffff0002-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000bb02', 'completed'),
  ('ffff0003-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000bb03', 'completed'),
  ('ffff0004-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000aa02', null, 'queued');

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb01"}';
select report_participant('ffff0001-0000-0000-0000-000000000001', 'harassment', '', false);
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb02"}';
select report_participant('ffff0002-0000-0000-0000-000000000002', 'harassment', '', false);
reset role;
select t_expect(not (select is_blocked from profiles where id = '00000000-0000-0000-0000-00000000aa02'),
  '2人からの通報では止まらない');
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb03"}';
select report_participant('ffff0003-0000-0000-0000-000000000003', 'harassment', '', false);
reset role;
select t_expect((select is_blocked from profiles where id = '00000000-0000-0000-0000-00000000aa02'),
  '3人目の通報で依頼者も止まる（以前はボランティアしか止まらなかった）');
select t_expect((select state from help_requests where id = 'ffff0004-0000-0000-0000-000000000004') = 'cancelled',
  '止まった依頼者の待っている依頼は取り下げられる');

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aa02"}';
select t_expect_error(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  'REQUESTER_BLOCKED', '止まった依頼者は依頼を立てられない');
select t_expect_error(
  $q$select consume_ocr_quota()$q$,
  'USER_BLOCKED', '止まった人は読み取りも使えない');

\echo '--- 6. 利用停止を外せるのは運営だけ ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb01"}';
select t_expect_error(
  $q$select set_user_blocked('00000000-0000-0000-0000-00000000aa02', false)$q$,
  'NOT_AN_ADMIN', '運営でない人は利用停止を外せない');
select t_expect_error(
  $q$update profiles set is_blocked = false where id = auth.uid()$q$,
  'permission denied', '自分の利用停止を自分で外せない（列権限）');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc01"}';
select t_expect_ok(
  $q$select set_user_blocked('00000000-0000-0000-0000-00000000aa02', false)$q$,
  '運営は利用停止を外せる（誤って止まった人を戻す）');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aa02"}';
select t_expect_ok(
  $q$insert into help_requests (requester_id) values (auth.uid())$q$,
  '外されたら、また依頼を立てられる');

\echo '--- 7. 読み取り（OCR）の上限 ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aa01"}';
select count(*) from (select consume_ocr_quota() from generate_series(1, 30)) x \gset ocr_
select t_expect(:ocr_count = 30, '10分に30回までは読み取れる');
select t_expect_error($q$select consume_ocr_quota()$q$, 'RATE_LIMITED', '31回目は止まる');
select t_expect_error($q$select count(*) from ocr_requests$q$, 'permission denied',
  '回数の記録は利用者から見えない');

reset request.jwt.claims;
select t_expect_error($q$select consume_ocr_quota()$q$, 'NOT_SIGNED_IN',
  'ログインしていなければ読み取りは使えない');
reset role;

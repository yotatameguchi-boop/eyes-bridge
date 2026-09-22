\set ON_ERROR_STOP on
\pset pager off

-- 期待どおりに失敗することを確かめるヘルパ
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

-- ------------------------------------------------------------- 登場人物
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),  -- 依頼者 R
  ('00000000-0000-0000-0000-0000000000b1'),  -- ボラ V1
  ('00000000-0000-0000-0000-0000000000b2'),  -- ボラ V2
  ('00000000-0000-0000-0000-0000000000b3'),  -- ボラ V3
  ('00000000-0000-0000-0000-0000000000b4'),  -- ボラ V4
  ('00000000-0000-0000-0000-0000000000c1');  -- 管理者 A

insert into profiles (id, role, display_name, is_admin) values
  ('00000000-0000-0000-0000-0000000000a1','requester','R',   false),
  ('00000000-0000-0000-0000-0000000000b1','volunteer','V1',  false),
  ('00000000-0000-0000-0000-0000000000b2','volunteer','V2',  false),
  ('00000000-0000-0000-0000-0000000000b3','volunteer','V3',  false),
  ('00000000-0000-0000-0000-0000000000b4','volunteer','V4',  false),
  ('00000000-0000-0000-0000-0000000000c1','volunteer','A',   true);

insert into volunteer_status (user_id) values
  ('00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000000b4'),
  ('00000000-0000-0000-0000-0000000000c1');

\echo '--- 1. 審査前は待機列が見えない / 取れない ---'
set role authenticated;
set app.uid = '00000000-0000-0000-0000-0000000000a1';
insert into help_requests (id, requester_id) values ('aaaa0001-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1');

set app.uid = '00000000-0000-0000-0000-0000000000b1';
select t_expect((select count(*) from help_requests) = 0, '未審査のボランティアに待機列が見えない');
select t_expect_error(
  $q$select claim_help_request('aaaa0001-0000-0000-0000-000000000001')$q$,
  'NOT_APPROVED', '未審査のボランティアは依頼を取れない');

\echo '--- 2. 自己承認ができない（列権限） ---'
select t_expect_error(
  $q$update volunteer_status set review_state = 'approved' where user_id = auth.uid()$q$,
  'permission denied', '自分で自分を承認できない');
select t_expect_error(
  $q$update profiles set is_admin = true where id = auth.uid()$q$,
  'permission denied', '自分を管理者にできない');

\echo '--- 3. 規約同意と承認を経ると取れる ---'
select agree_to_terms();
set app.uid = '00000000-0000-0000-0000-0000000000c1';
select review_volunteer('00000000-0000-0000-0000-0000000000b1', 'approved');
set app.uid = '00000000-0000-0000-0000-0000000000b1';
select t_expect((select count(*) from help_requests where state='queued') = 1, '承認後は待機列が見える');

\echo '--- 4. 管理者でない人は審査できない ---'
select t_expect_error(
  $q$select review_volunteer('00000000-0000-0000-0000-0000000000b2','approved')$q$,
  'NOT_AN_ADMIN', '一般ボランティアは他人を承認できない');

\echo '--- 5. 取り合いは1人しか勝たない ---'
select t_expect((claim_help_request('aaaa0001-0000-0000-0000-000000000001')).state = 'active', 'V1 が依頼を取れる');
set app.uid = '00000000-0000-0000-0000-0000000000c1';
select review_volunteer('00000000-0000-0000-0000-0000000000b2','approved');
set app.uid = '00000000-0000-0000-0000-0000000000b2';
select agree_to_terms();
select t_expect_error(
  $q$select claim_help_request('aaaa0001-0000-0000-0000-000000000001')$q$,
  'ALREADY_TAKEN', '2人目は ALREADY_TAKEN で負ける（ID は着信時に既に持っている）');

\echo '--- 6. ブロックした相手とは繋がらない ---'
set app.uid = '00000000-0000-0000-0000-0000000000c1';
select review_volunteer('00000000-0000-0000-0000-0000000000b3','approved');
set app.uid = '00000000-0000-0000-0000-0000000000b3';
select agree_to_terms();
set app.uid = '00000000-0000-0000-0000-0000000000a1';
insert into blocks (blocker_id, blocked_id) values (auth.uid(), '00000000-0000-0000-0000-0000000000b3');
insert into help_requests (id, requester_id) values ('aaaa0002-0000-0000-0000-000000000002', auth.uid());
set app.uid = '00000000-0000-0000-0000-0000000000b3';
select t_expect((select count(*) from help_requests where state='queued') = 0, 'ブロックされた人には依頼が見えない');
set role postgres;
select t_expect_error(
  $q$set role authenticated; set app.uid = '00000000-0000-0000-0000-0000000000b3';
     select claim_help_request('aaaa0002-0000-0000-0000-000000000002')$q$,
  'BLOCKED', 'ブロックされた人は依頼を取れない');

\echo '--- 7. 通報は当事者しか出せない ---'
set role authenticated;
set app.uid = '00000000-0000-0000-0000-0000000000b4';
select t_expect_error(
  $q$select report_participant('aaaa0001-0000-0000-0000-000000000001', 'harassment')$q$,
  'NOT_A_PARTICIPANT', '無関係の人は通報できない');
select t_expect_error(
  $q$insert into reports (request_id, reporter_id, reported_id, reason)
     values ('aaaa0001-0000-0000-0000-000000000001', auth.uid(), auth.uid(), 'other')$q$,
  'row-level security', '通報テーブルへの直接 insert は塞がれている');

\echo '--- 8. 通報が3人から集まると自動停止 ---'
set role postgres;
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3');
insert into profiles (id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a2','requester','R2'),
  ('00000000-0000-0000-0000-0000000000a3','requester','R3');
-- V1 が3件の通話を受け、3人の別々の依頼者から通報される
insert into help_requests (id, requester_id, volunteer_id, state) values
  ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','active'),
  ('22222222-2222-2222-2222-222222222222','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b1','active'),
  ('33333333-3333-3333-3333-333333333333','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000b1','active');
set role authenticated;
set app.uid = '00000000-0000-0000-0000-0000000000a1';
select report_participant('11111111-1111-1111-1111-111111111111','privacy','', false);
set app.uid = '00000000-0000-0000-0000-0000000000a2';
select report_participant('22222222-2222-2222-2222-222222222222','privacy','', false);
set role postgres;
select t_expect((select review_state from volunteer_status where user_id='00000000-0000-0000-0000-0000000000b1') = 'approved', '2件では停止しない');
set role authenticated;
set app.uid = '00000000-0000-0000-0000-0000000000a3';
select report_participant('33333333-3333-3333-3333-333333333333','privacy','', false);
set role postgres;
select t_expect((select review_state from volunteer_status where user_id='00000000-0000-0000-0000-0000000000b1') = 'suspended', '3人目の通報で自動停止する');
set role authenticated;
set app.uid = '00000000-0000-0000-0000-0000000000b1';
select t_expect(not is_approved_volunteer(auth.uid()), '停止後は承認済みでなくなる');

\echo '--- 9. 通報された側に通報は見えない ---'
select t_expect((select count(*) from reports) = 0, '通報された本人には通報が見えない');
set app.uid = '00000000-0000-0000-0000-0000000000a1';
select t_expect((select count(*) from reports) = 1, '自分が出した通報だけ見える');
reset role;

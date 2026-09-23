\set ON_ERROR_STOP on
\pset pager off

-- 本人確認まわり。safety_test.sql とは別の DB 状態を前提にしないよう、
-- 登場人物をここで作り直す。

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

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000d1'),  -- ボラ W1
  ('00000000-0000-0000-0000-0000000000d2'),  -- ボラ W2
  ('00000000-0000-0000-0000-0000000000e1');  -- 管理者 B

insert into profiles (id, role, display_name, is_admin) values
  ('00000000-0000-0000-0000-0000000000d1','volunteer','W1', false),
  ('00000000-0000-0000-0000-0000000000d2','volunteer','W2', false),
  ('00000000-0000-0000-0000-0000000000e1','volunteer','B',  true);

insert into volunteer_status (user_id) values
  ('00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000d2'),
  ('00000000-0000-0000-0000-0000000000e1');

\echo '--- 1. 本人確認なしでは承認できない ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select t_expect_error(
  $q$select review_volunteer('00000000-0000-0000-0000-0000000000d1','approved')$q$,
  'IDENTITY_NOT_VERIFIED', '本人確認前のボランティアは承認できない');
select t_expect_ok(
  $q$select review_volunteer('00000000-0000-0000-0000-0000000000d1','suspended')$q$,
  '停止は本人確認なしでもできる（問題時に止められないと困る）');

\echo '--- 2. 個人番号は受け取らない ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select t_expect_error(
  $q$select submit_identity('my_number_card',
       '00000000-0000-0000-0000-0000000000d1/front.jpg',
       '00000000-0000-0000-0000-0000000000d1/selfie.jpg',
       '00000000-0000-0000-0000-0000000000d1/back.jpg')$q$,
  'MY_NUMBER_BACK_NOT_ACCEPTED', 'マイナンバーカードの裏面は受け付けない');

\echo '--- 3. 他人の画像を自分の審査に使えない ---'
select t_expect_error(
  $q$select submit_identity('drivers_license',
       '00000000-0000-0000-0000-0000000000d2/front.jpg',
       '00000000-0000-0000-0000-0000000000d1/selfie.jpg',
       null)$q$,
  'PATH_NOT_OWNED', '他人のフォルダのパスは提出できない');

\echo '--- 4. 提出して審査を通すと承認できる ---'
select t_expect(
  (submit_identity('drivers_license',
     '00000000-0000-0000-0000-0000000000d1/front.jpg',
     '00000000-0000-0000-0000-0000000000d1/selfie.jpg',
     '00000000-0000-0000-0000-0000000000d1/back.jpg')).state = 'submitted',
  '免許証を提出できる');

select t_expect_error(
  $q$select submit_identity('drivers_license',
       '00000000-0000-0000-0000-0000000000d1/front2.jpg',
       '00000000-0000-0000-0000-0000000000d1/selfie2.jpg', null)$q$,
  'identity_one_open_per_user', '審査待ちを二重に積めない');

-- 本人でない一般ユーザーは審査できない
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select t_expect_error(
  $q$select review_identity((select id from identity_verifications limit 1), true)$q$,
  'NOT_AN_ADMIN', '一般ユーザーは本人確認を審査できない');
select t_expect((select count(*) from identity_verifications) = 0, '他人の本人確認は見えない');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select t_expect((select count(*) from identity_verifications) = 1, '自分の本人確認は見える');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select t_expect((select count(*) from identity_verifications) = 1, '運営は本人確認を見られる');
select review_identity((select id from identity_verifications limit 1), true);
select t_expect_ok(
  $q$select review_volunteer('00000000-0000-0000-0000-0000000000d1','approved')$q$,
  '本人確認が済めば承認できる');

\echo '--- 5. 状態を自分で書き換えられない ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select t_expect_error(
  $q$insert into identity_verifications (user_id, kind, front_path, selfie_path, state)
     values (auth.uid(), 'drivers_license', 'x', 'y', 'approved')$q$,
  'row-level security', '本人確認テーブルへの直接 insert は塞がれている');

\echo '--- 6. Storage は自分のフォルダだけ ---'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select t_expect_error(
  $q$insert into storage.objects (bucket_id, name)
     values ('identity-documents','00000000-0000-0000-0000-0000000000d2/front.jpg')$q$,
  'row-level security', '他人のフォルダには置けない');
insert into storage.objects (bucket_id, name)
     values ('identity-documents','00000000-0000-0000-0000-0000000000d1/front.jpg');
select t_expect((select count(*) from storage.objects) = 1, '自分のフォルダには置ける');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';
select t_expect((select count(*) from storage.objects) = 0, '他人の書類は読めない');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1"}';
select t_expect((select count(*) from storage.objects) = 1, '運営は書類を読める');

\echo '--- 7. 審査済みの画像は消す対象に挙がる ---'
set role postgres;
update identity_verifications set purge_after = now() - interval '1 day';
select t_expect((select count(*) from identity_documents_to_purge()) = 1, '期限切れの書類が洗い出される');
select t_expect(
  (select array_length(paths, 1) from identity_documents_to_purge() limit 1) = 3,
  '表・裏・自撮りの3枚が対象になる');
select mark_identity_purged((select id from identity_verifications limit 1));
select t_expect((select count(*) from identity_documents_to_purge()) = 0, '消したあとは対象から外れる');
select t_expect(
  (select state from identity_verifications limit 1) = 'approved',
  '画像を消しても審査の結果は残る');
reset role;

\set ON_ERROR_STOP on
\pset pager off

-- 段階的な着信と、鳴らさない時間帯（0013_ring_waves.sql）。

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

\echo '--- 1. 鳴らさない時間帯の判定 ---'
-- 日本時間 23:30（= UTC 14:30）
select t_expect(in_quiet_hours('22:00', '07:00', 'Asia/Tokyo', '2026-09-26 14:30:00+00'),
  '22時〜7時の設定なら、23時半は鳴らさない（日付をまたぐ）');
select t_expect(in_quiet_hours('22:00', '07:00', 'Asia/Tokyo', '2026-09-26 21:59:00+00'),
  '同じ設定で、朝6時59分も鳴らさない');
select t_expect(not in_quiet_hours('22:00', '07:00', 'Asia/Tokyo', '2026-09-26 22:00:00+00'),
  '同じ設定で、朝7時ちょうどからは鳴らす');
select t_expect(not in_quiet_hours('22:00', '07:00', 'Asia/Tokyo', '2026-09-26 03:00:00+00'),
  '同じ設定で、昼12時は鳴らす');
select t_expect(in_quiet_hours('13:00', '14:00', 'Asia/Tokyo', '2026-09-26 04:30:00+00'),
  '日付をまたがない設定（13時〜14時）も扱える');
select t_expect(not in_quiet_hours(null, null, 'Asia/Tokyo', '2026-09-26 14:30:00+00'),
  '設定していなければ、いつでも鳴らす');

-- 登場人物
insert into auth.users (id)
select ('00000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid from generate_series(1, 12) i;
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000eff01');  -- 依頼者 R

insert into profiles (id, role, display_name)
select ('00000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid, 'volunteer', 'V' || i
  from generate_series(1, 12) i;
insert into profiles (id, role, display_name)
     values ('00000000-0000-0000-0000-0000000eff01', 'requester', 'R');

insert into consents (user_id, document, version)
select p.id, d, current_consent_version(d)
  from profiles p cross join unnest(array['terms', 'privacy', 'sensitive']) as d;

-- V1〜V7：鳴らしてよい人。V8〜V12：鳴らしてはいけない人
insert into volunteer_status (user_id, review_state, agreed_to_terms_at, is_available, push_token, last_seen_at)
select ('00000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid,
       case when i = 12 then 'pending' else 'approved' end::volunteer_review_state,
       now(),
       i <> 10,                                    -- V10 は待機していない
       case when i = 11 then null else 'tok-' || i end,  -- V11 は通知先が無い
       now() - make_interval(mins => i)            -- 最近開いた人から順に鳴らす
  from generate_series(1, 12) i;
update volunteer_status set quiet_start = '22:00', quiet_end = '07:00'   -- V8 は鳴らさない時間帯
 where user_id = '00000000-0000-0000-0000-0000000e0008';
insert into blocks (blocker_id, blocked_id)                              -- R が V9 をブロック
     values ('00000000-0000-0000-0000-0000000eff01', '00000000-0000-0000-0000-0000000e0009');

insert into help_requests (id, requester_id)
     values ('e0000001-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000eff01');

\echo '--- 2. 段階的に鳴らす ---'
-- 日本時間 23:30 に鳴らす（V8 の鳴らさない時間帯）
select count(*) from take_ring_wave('e0000001-0000-0000-0000-000000000001', 1, 5, '2026-09-26 14:30:00+00') \gset w1_
select t_expect(:w1_count = 5, '1段目は5人だけ鳴らす（以前は一度に最大50人）');
select t_expect(
  (select array_agg(user_id order by user_id) from request_rings where wave = 1)
  = array(select ('00000000-0000-0000-0000-0000000e' || lpad(i::text, 4, '0'))::uuid from generate_series(1, 5) i order by 1),
  '1段目は、最近アプリを開いた人から選ぶ');

select count(*) from take_ring_wave('e0000001-0000-0000-0000-000000000001', 2, 15, '2026-09-26 14:30:00+00') \gset w2_
select t_expect(:w2_count = 2, '2段目は、まだ鳴らしていない残りの人（V6・V7）だけ');

select t_expect(not exists (select 1 from request_rings where user_id in (
    '00000000-0000-0000-0000-0000000e0008', '00000000-0000-0000-0000-0000000e0009',
    '00000000-0000-0000-0000-0000000e0010', '00000000-0000-0000-0000-0000000e0011',
    '00000000-0000-0000-0000-0000000e0012')),
  '鳴らさない時間帯・ブロック関係・待機していない・通知先が無い・審査前の人は鳴らさない');

select count(*) from take_ring_wave('e0000001-0000-0000-0000-000000000001', 3, 30, '2026-09-26 14:30:00+00') \gset w3_
select t_expect(:w3_count = 0, '全員に鳴らし終えたら、3段目は誰も鳴らさない');
select t_expect((select count(*) = count(distinct user_id) from request_rings),
  '同じ人を同じ依頼で2回は鳴らさない');

\echo '--- 3. 誰かが取ったら、次の段は鳴らさない ---'
insert into help_requests (id, requester_id)
     values ('e0000002-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000eff01');
select count(*) from take_ring_wave('e0000002-0000-0000-0000-000000000002', 1, 2, '2026-09-26 03:00:00+00') \gset x1_
update help_requests set state = 'active', volunteer_id = '00000000-0000-0000-0000-0000000e0001', matched_at = now()
 where id = 'e0000002-0000-0000-0000-000000000002';
select count(*) from take_ring_wave('e0000002-0000-0000-0000-000000000002', 2, 15, '2026-09-26 03:00:00+00') \gset x2_
select t_expect(:x1_count = 2 and :x2_count = 0, '取られた依頼では、次の段は誰も鳴らさない');

\echo '--- 4. 昼なら、鳴らさない時間帯の人も鳴らす ---'
insert into help_requests (id, requester_id)
     values ('e0000003-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000eff01');
select t_expect(
  exists (select 1 from take_ring_wave('e0000003-0000-0000-0000-000000000003', 1, 50, '2026-09-26 03:00:00+00')
           where user_id = '00000000-0000-0000-0000-0000000e0008'),
  '22時〜7時を設定した人も、昼12時には鳴らす');

\echo '--- 5. 利用者から触れる範囲 ---'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e0001"}';
select t_expect_ok(
  $q$update volunteer_status set quiet_start = '23:00', quiet_end = '06:00' where user_id = auth.uid()$q$,
  'ボランティアは自分の鳴らさない時間帯を設定できる');
select t_expect_error(
  $q$select * from take_ring_wave('e0000003-0000-0000-0000-000000000003', 9, 50)$q$,
  'permission denied', '利用者は着信の段を直接動かせない');
select t_expect_error(
  $q$select count(*) from request_rings$q$,
  'permission denied', '誰がいつ鳴らされたかは利用者から見えない');
reset role;

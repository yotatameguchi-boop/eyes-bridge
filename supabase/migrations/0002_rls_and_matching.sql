-- 行レベルセキュリティと、取り合いを解決する RPC

alter table profiles         enable row level security;
alter table volunteer_status enable row level security;
alter table help_requests    enable row level security;

-- ---------------------------------------------------------------- profiles
create policy "自分のプロフィールは読める"
  on profiles for select using (id = auth.uid());

create policy "自分のプロフィールは作れる"
  on profiles for insert with check (id = auth.uid());

create policy "自分のプロフィールは更新できる"
  on profiles for update using (id = auth.uid());

-- ------------------------------------------------------- volunteer_status
create policy "自分の待機状態は読める"
  on volunteer_status for select using (user_id = auth.uid());

create policy "自分の待機状態は作れる"
  on volunteer_status for insert with check (user_id = auth.uid());

create policy "自分の待機状態は更新できる"
  on volunteer_status for update using (user_id = auth.uid());

-- ----------------------------------------------------------- help_requests
create or replace function is_volunteer(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = uid and role = 'volunteer');
$$;

-- 依頼者は自分の依頼だけ。ボランティアは「待機中の依頼」と「自分が取った依頼」。
-- 依頼には本文も位置情報も無いので、待機中の行が見えても晒される情報は無い。
create policy "依頼は当事者と待機中の行だけ見える"
  on help_requests for select using (
        requester_id = auth.uid()
     or volunteer_id = auth.uid()
     or (state = 'queued' and is_volunteer(auth.uid()))
  );

create policy "依頼は自分名義でだけ作れる"
  on help_requests for insert with check (
    requester_id = auth.uid() and state = 'queued' and volunteer_id is null
  );

-- 取得(claim)は RPC 経由に限定する。直接 update できるのは
-- 「自分が当事者で、かつ通話を終わらせる」場合だけ。
create policy "当事者は自分の通話を終われる"
  on help_requests for update using (
    requester_id = auth.uid() or volunteer_id = auth.uid()
  ) with check (
    requester_id = auth.uid() or volunteer_id = auth.uid()
  );

-- ------------------------------------------------------------- 取り合い解決
-- 同時に3人が「受ける」を押しても、UPDATE が通るのは1人だけ。
-- returning が空 = 誰かに先を越された、という判定にそのまま使える。
create or replace function claim_help_request(p_request uuid)
returns help_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed help_requests;
begin
  if not is_volunteer(auth.uid()) then
    raise exception 'NOT_A_VOLUNTEER' using errcode = '42501';
  end if;

  update help_requests
     set state        = 'active',
         volunteer_id = auth.uid(),
         matched_at   = now()
   where id = p_request
     and state = 'queued'
  returning * into claimed;

  if claimed.id is null then
    raise exception 'ALREADY_TAKEN' using errcode = '55000';
  end if;

  update volunteer_status
     set accepted_count = accepted_count + 1,
         updated_at     = now()
   where user_id = auth.uid();

  return claimed;
end;
$$;

grant execute on function claim_help_request(uuid) to authenticated;

-- ------------------------------------------------------------ 終了処理
create or replace function end_help_request(p_request uuid, p_state request_state)
returns help_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  ended help_requests;
begin
  if p_state not in ('completed', 'cancelled') then
    raise exception 'INVALID_END_STATE' using errcode = '22023';
  end if;

  update help_requests
     set state    = p_state,
         ended_at = now()
   where id = p_request
     and state in ('queued', 'active')
     and (requester_id = auth.uid() or volunteer_id = auth.uid())
  returning * into ended;

  if ended.id is null then
    raise exception 'NOT_FOUND_OR_NOT_PARTICIPANT' using errcode = '42501';
  end if;

  return ended;
end;
$$;

grant execute on function end_help_request(uuid, request_state) to authenticated;

-- --------------------------------------------- 誰も取らなかった依頼の掃除
-- pg_cron などから1分おきに叩く想定。
create or replace function expire_stale_requests(p_after interval default interval '3 minutes')
returns integer
language sql
security definer
set search_path = public
as $$
  with expired as (
    update help_requests
       set state = 'timed_out', ended_at = now()
     where state = 'queued' and created_at < now() - p_after
    returning 1
  )
  select count(*)::int from expired;
$$;

-- ------------------------------------------------------------- Realtime
-- ボランティアは INSERT を、依頼者は自分の行の UPDATE を購読する。
alter publication supabase_realtime add table help_requests;

-- 着信を段階的に鳴らす。鳴らさない時間帯を持てるようにする。
--
-- それまでは1つの依頼で、待機中のボランティア最大50人を一度に鳴らしていた。
-- 取れるのは1人だけなので、残りの49人は「鳴ったのに出たら終わっていた」を
-- 繰り返すことになる。深夜も区別なく鳴った。
--
-- 今は、最初に数人、誰も取らなければ次の数人…と段階的に鳴らす
-- （段の大きさと間隔は ring-volunteers が決める）。誰かが取った時点で次の段は鳴らない。
-- 同じ人を同じ依頼で2回は鳴らさない。

-- ------------------------------------------------------ 鳴らさない時間帯
alter table volunteer_status
  add column quiet_start time,
  add column quiet_end   time,
  add column timezone    text not null default 'Asia/Tokyo';

-- 本人が設定できる（審査や停止に関わる列ではないので）
grant update (quiet_start, quiet_end) on volunteer_status to authenticated;

-- 「22:00〜07:00」のように日付をまたぐ時間帯も扱う
create or replace function in_quiet_hours(
  p_start time,
  p_end   time,
  p_tz    text,
  p_now   timestamptz default now()
)
returns boolean
language sql
stable
as $$
  select case
    when p_start is null or p_end is null or p_start = p_end then false
    when p_start < p_end then (p_now at time zone p_tz)::time >= p_start
                          and (p_now at time zone p_tz)::time <  p_end
    else (p_now at time zone p_tz)::time >= p_start
      or (p_now at time zone p_tz)::time <  p_end
  end;
$$;

-- ------------------------------------------------------ 誰をいつ鳴らしたか
create table request_rings (
  request_id uuid        not null references help_requests(id) on delete cascade,
  user_id    uuid        not null references profiles(id) on delete cascade,
  wave       integer     not null,
  rung_at    timestamptz not null default now(),
  primary key (request_id, user_id)
);

alter table request_rings enable row level security;
revoke all on request_rings from authenticated, anon;

-- 次の段で鳴らす人を選び、「鳴らした」と記録して返す。1つの処理で行うので、
-- 同じ依頼の段が重なって呼ばれても同じ人は2回選ばれない。
-- 依頼がもう待っていない（誰かが取った・取り下げた）なら誰も返さない。
create or replace function take_ring_wave(
  p_request uuid,
  p_wave    integer,
  p_limit   integer,
  p_now     timestamptz default now()
)
returns table (user_id uuid, push_token text, push_kind text)
language plpgsql
security definer
set search_path = public
as $$
declare
  req help_requests;
begin
  select * into req from help_requests where id = p_request for update;
  if req.id is null or req.state <> 'queued' then
    return;
  end if;

  return query
  with picked as (
    select v.user_id, v.push_token, v.push_kind
      from volunteer_status v
     where v.is_available
       and v.push_token is not null
       and v.language = req.language
       and is_approved_volunteer(v.user_id)
       and not blocked_between(req.requester_id, v.user_id)
       and not in_quiet_hours(v.quiet_start, v.quiet_end, v.timezone, p_now)
       and not exists (
         select 1 from request_rings r
          where r.request_id = p_request and r.user_id = v.user_id
       )
     order by v.last_seen_at desc
     limit p_limit
  ), recorded as (
    insert into request_rings (request_id, user_id, wave)
    select p_request, picked.user_id, p_wave from picked
    returning request_rings.user_id
  )
  select picked.user_id, picked.push_token, picked.push_kind
    from picked
    join recorded on recorded.user_id = picked.user_id;
end;
$$;

revoke execute on function take_ring_wave(uuid, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function take_ring_wave(uuid, integer, integer, timestamptz) to service_role;

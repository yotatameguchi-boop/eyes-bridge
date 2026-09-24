-- 悪用を塞ぐ。
--
-- それまでの状態では、アカウントを1つ作るだけで次のことができた:
--   * 依頼を何件でも立て、同じ依頼で着信を何度でも送れる
--     → 待機中のボランティア最大50人のスマホを、電話の着信画面で延々と鳴らせる
--   * 依頼の表の自分の行を、どの列でも直接書き換えられる
--     （作成時刻をずらして上限をすり抜ける、状態や担当を勝手に変える）
--   * 悪質な依頼者は、何人から通報されても止まらない
--     （自動停止はボランティアにしか効いていなかった）
--   * 読み取り（OCR）を回数無制限で使える
--
-- 上限の値は、目の見えない人が普通に使う範囲（撮り直し・繋がらずに再依頼）を
-- 妨げない程度に緩く取ってある。

-- -------------------------------------- 1. 依頼の表を直接書き換えさせない
-- 状態の変化（取る・終える）は claim_help_request / end_help_request だけが行う。
-- 作るときに書けるのは「誰の依頼か」と言語だけ。作成時刻・部屋名・状態は
-- サーバが決める（作成時刻を書かせると、回数の上限をすり抜けられる）。
-- id は固定値で作りたいテストのために残す（UUID なので推測も衝突もしない）。
drop policy "当事者は自分の通話を終われる" on help_requests;

revoke insert, update, delete on help_requests from authenticated, anon;
grant insert (id, requester_id, language) on help_requests to authenticated;

-- ------------------------------------------------- 2. 着信は1依頼につき1回
alter table help_requests add column rung_at timestamptz;

-- 最初の1回だけ true を返す。ring-volunteers はこれが true のときだけ鳴らす。
create or replace function mark_request_rung(p_request uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update help_requests
     set rung_at = now()
   where id = p_request
     and requester_id = auth.uid()
     and state = 'queued'
     and rung_at is null;
  return found;
end;
$$;

grant execute on function mark_request_rung(uuid) to authenticated;

-- ------------------------------------------------------ 3. 依頼の数の上限
create or replace function enforce_request_limits()
returns trigger
language plpgsql
-- security invoker のまま。current_user で「利用者からの登録か」を見分けるため
set search_path = public
as $$
declare
  recent  integer;
  per_day integer;
begin
  -- 縛るのは利用者（authenticated）からの登録だけ。
  -- 運営やサーバ側（postgres / service_role）からの登録は対象外。
  if current_user <> 'authenticated' then
    return new;
  end if;

  -- 同じ人が同時に2件立てて、上の確認を2件ともすり抜けないように並べる
  perform pg_advisory_xact_lock(hashtext('help_requests:' || new.requester_id::text));

  if exists (select 1 from profiles where id = new.requester_id and is_blocked) then
    raise exception 'REQUESTER_BLOCKED' using errcode = '42501';
  end if;

  -- 未処理の依頼は1人1件。ただし、取られないまま時間切れになったもの・
  -- 終了の処理が漏れた通話（アプリが落ちた等）は数えない。
  -- それを数えると、落ちたあと何時間も新しい依頼を立てられなくなる。
  if exists (
    select 1 from help_requests
     where requester_id = new.requester_id
       and (   (state = 'queued' and created_at > now() - interval '3 minutes')
            or (state = 'active' and matched_at > now() - interval '2 hours'))
  ) then
    raise exception 'REQUEST_ALREADY_OPEN' using errcode = '55000';
  end if;

  select count(*) into recent
    from help_requests
   where requester_id = new.requester_id
     and created_at > now() - interval '10 minutes';
  if recent >= 6 then
    raise exception 'RATE_LIMITED' using errcode = '54000';
  end if;

  select count(*) into per_day
    from help_requests
   where requester_id = new.requester_id
     and created_at > now() - interval '24 hours';
  if per_day >= 40 then
    raise exception 'RATE_LIMITED' using errcode = '54000';
  end if;

  return new;
end;
$$;

create trigger help_requests_limits
  before insert on help_requests
  for each row execute function enforce_request_limits();

-- 取られずに残った依頼と、終了の処理が漏れた通話を片付ける（pg_cron から毎分）
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
  ), abandoned as (
    update help_requests
       set state = 'completed', ended_at = now()
     where state = 'active' and matched_at < now() - interval '2 hours'
    returning 1
  )
  select ((select count(*) from expired) + (select count(*) from abandoned))::int;
$$;

-- ------------------------------------ 4. 依頼者も、通報が重なれば止める
-- 以前はボランティアの review_state しか見ておらず、依頼者は何人から
-- 通報されても、通報した人がそれぞれブロックするだけだった。
create or replace function auto_suspend_on_reports()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  distinct_reporters integer;
begin
  select count(distinct reporter_id) into distinct_reporters
    from reports
   where reported_id = new.reported_id
     and created_at > now() - interval '90 days';

  if distinct_reporters >= 3 then
    update volunteer_status
       set review_state = 'suspended', reviewed_at = now(), is_available = false
     where user_id = new.reported_id
       and review_state = 'approved';

    -- 依頼者は利用そのものを止める。待っている依頼も取り下げる。
    -- 誤って止めた場合は、運営が set_user_blocked で外せる。
    update profiles
       set is_blocked = true
     where id = new.reported_id
       and role = 'requester'
       and not is_blocked;

    if found then
      update help_requests
         set state = 'cancelled', ended_at = now()
       where requester_id = new.reported_id
         and state = 'queued';
    end if;
  end if;

  return new;
end;
$$;

-- 運営が利用停止を掛ける・外す。
-- 依頼者にとっては「助けを呼べなくなる」ことなので、自動で止まった人を
-- 運営が見直して外せないといけない。
create or replace function set_user_blocked(p_user uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(auth.uid()) then
    raise exception 'NOT_AN_ADMIN' using errcode = '42501';
  end if;

  update profiles set is_blocked = p_blocked where id = p_user;
  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = '02000';
  end if;

  if p_blocked then
    update help_requests
       set state = 'cancelled', ended_at = now()
     where requester_id = p_user and state = 'queued';
    update volunteer_status set is_available = false where user_id = p_user;
  end if;
end;
$$;

grant execute on function set_user_blocked(uuid, boolean) to authenticated;

-- ---------------------------------------------- 5. 読み取り（OCR）の上限
-- read-image（Edge Function）が OCR に渡す前に呼ぶ。
-- 表は誰にも直接読ませない・書かせない（ポリシーを作らない）。
create table ocr_requests (
  user_id    uuid        not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index ocr_requests_user_idx on ocr_requests (user_id, created_at desc);
alter table ocr_requests enable row level security;
revoke all on ocr_requests from authenticated, anon;

create or replace function consume_ocr_quota()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  recent integer;
begin
  if me is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if exists (select 1 from profiles where id = me and is_blocked) then
    raise exception 'USER_BLOCKED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('ocr:' || me::text));

  -- 撮り直しを何度か繰り返しても当たらない程度に緩く
  select count(*) into recent
    from ocr_requests
   where user_id = me
     and created_at > now() - interval '10 minutes';
  if recent >= 30 then
    raise exception 'RATE_LIMITED' using errcode = '54000';
  end if;

  insert into ocr_requests (user_id) values (me);
end;
$$;

grant execute on function consume_ocr_quota() to authenticated;

-- 数えるのに要るのは直近だけなので、古い記録は毎日消す
create or replace function prune_ocr_requests()
returns integer language sql security definer set search_path = public as $$
  with gone as (
    delete from ocr_requests where created_at < now() - interval '1 day' returning 1
  )
  select count(*)::int from gone;
$$;

do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('prune-ocr-requests', '41 4 * * *', $$select public.prune_ocr_requests()$$);
  end if;
end
$outer$;

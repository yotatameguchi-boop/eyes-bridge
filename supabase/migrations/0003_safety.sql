-- 誰でも他人のカメラ映像を見られる状態を塞ぐ。
--
-- 塞ぐのは3つ:
--   1. 審査を通っていないボランティアに待機列を見せない
--   2. 通報とブロックを入れ、ブロック相手とは二度と繋がらないようにする
--   3. 自分で自分を承認できないよう、列単位で書き込み権限を剥がす

-- ------------------------------------------------------------- 1. 審査
create type volunteer_review_state as enum (
  'pending',    -- 登録直後。待機列は見えない
  'approved',   -- 審査を通った
  'suspended',  -- 通報が重なって自動停止
  'rejected'
);

alter table volunteer_status
  add column review_state       volunteer_review_state not null default 'pending',
  add column agreed_to_terms_at timestamptz,
  add column reviewed_at        timestamptz,
  add column reviewed_by        uuid references profiles(id);

alter table profiles add column is_admin boolean not null default false;
alter table profiles add column is_blocked boolean not null default false;

-- 待機できるのは「規約に同意し、かつ承認された」ボランティアだけ。
-- 同意だけでも承認だけでも通さない。
create or replace function is_approved_volunteer(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from profiles p
      join volunteer_status v on v.user_id = p.id
     where p.id = uid
       and p.role = 'volunteer'
       and not p.is_blocked
       and v.review_state = 'approved'
       and v.agreed_to_terms_at is not null
  );
$$;

-- ------------------------------------------------------- 2. 通報・ブロック
create type report_reason as enum (
  'inappropriate',  -- 不適切な発言・態度
  'privacy',        -- 映したくないものを見ようとした
  'harassment',
  'no_help',        -- 繋がったが何もしなかった
  'other'
);

create table reports (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid          not null references help_requests(id) on delete cascade,
  reporter_id uuid          not null references profiles(id) on delete cascade,
  reported_id uuid          not null references profiles(id) on delete cascade,
  reason      report_reason not null,
  detail      text          not null default '',
  created_at  timestamptz   not null default now(),
  handled_at  timestamptz,
  handled_by  uuid          references profiles(id),
  -- 同じ通話について同じ人を二度通報しても1件に畳む
  unique (request_id, reporter_id)
);

create index reports_reported_idx on reports (reported_id, created_at desc);

create table blocks (
  blocker_id uuid        not null references profiles(id) on delete cascade,
  blocked_id uuid        not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocks_blocked_idx on blocks (blocked_id);

-- どちらの向きのブロックでも繋がらない。
-- 「ブロックした側だけ守られる」だと、通報された側が
-- 相手を選んで取り続けられてしまう。
create or replace function blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from blocks
     where (blocker_id = a and blocked_id = b)
        or (blocker_id = b and blocked_id = a)
  );
$$;

-- --------------------------------------------------- 3. 取り合いの再定義
-- 承認済みであること、ブロック関係が無いことを取得時に確かめる。
create or replace function claim_help_request(p_request uuid)
returns help_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed   help_requests;
  requester uuid;
begin
  if not is_approved_volunteer(auth.uid()) then
    raise exception 'NOT_APPROVED' using errcode = '42501';
  end if;

  select requester_id into requester from help_requests where id = p_request;
  if requester is null then
    raise exception 'REQUEST_NOT_FOUND' using errcode = '02000';
  end if;

  if blocked_between(requester, auth.uid()) then
    raise exception 'BLOCKED' using errcode = '42501';
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

-- ------------------------------------------------------------- 通報する
-- 当事者だったことを確かめてから通報を立てる。
-- 相手が誰かはこちらで決める。クライアントに reported_id を
-- 選ばせると、無関係な人を通報できてしまう。
create or replace function report_participant(
  p_request uuid,
  p_reason  report_reason,
  p_detail  text default '',
  p_block   boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      help_requests;
  target uuid;
begin
  select * into r from help_requests where id = p_request;
  if r.id is null then
    raise exception 'REQUEST_NOT_FOUND' using errcode = '02000';
  end if;

  if auth.uid() = r.requester_id then
    target := r.volunteer_id;
  elsif auth.uid() = r.volunteer_id then
    target := r.requester_id;
  else
    raise exception 'NOT_A_PARTICIPANT' using errcode = '42501';
  end if;

  if target is null then
    raise exception 'NO_COUNTERPART' using errcode = '02000';
  end if;

  insert into reports (request_id, reporter_id, reported_id, reason, detail)
       values (p_request, auth.uid(), target, p_reason, left(coalesce(p_detail, ''), 1000))
  on conflict (request_id, reporter_id) do update
       set reason = excluded.reason, detail = excluded.detail;

  if p_block then
    insert into blocks (blocker_id, blocked_id)
         values (auth.uid(), target)
    on conflict do nothing;
  end if;
end;
$$;

grant execute on function report_participant(uuid, report_reason, text, boolean) to authenticated;

-- 通報が重なったボランティアは自動で止める。
-- 「別々の人から3回」を閾値にする。1人が連打しても止まらない。
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
       set review_state = 'suspended', reviewed_at = now()
     where user_id = new.reported_id
       and review_state = 'approved';
  end if;

  return new;
end;
$$;

create trigger reports_auto_suspend
  after insert on reports
  for each row execute function auto_suspend_on_reports();

-- ------------------------------------------------------------- 規約同意
create or replace function agree_to_terms()
returns void language plpgsql security definer set search_path = public as $$
begin
  update volunteer_status
     set agreed_to_terms_at = now(), updated_at = now()
   where user_id = auth.uid();

  if not found then
    raise exception 'NOT_A_VOLUNTEER' using errcode = '42501';
  end if;
end;
$$;

grant execute on function agree_to_terms() to authenticated;

-- ------------------------------------------------------------- 審査する
create or replace function review_volunteer(p_user uuid, p_state volunteer_review_state)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    raise exception 'NOT_AN_ADMIN' using errcode = '42501';
  end if;

  update volunteer_status
     set review_state = p_state, reviewed_at = now(), reviewed_by = auth.uid()
   where user_id = p_user;

  -- 承認を外したら、その場で待機からも降ろす
  if p_state <> 'approved' then
    update volunteer_status set is_available = false where user_id = p_user;
  end if;
end;
$$;

grant execute on function review_volunteer(uuid, volunteer_review_state) to authenticated;

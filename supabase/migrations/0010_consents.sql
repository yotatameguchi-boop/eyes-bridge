-- 同意。要配慮個人情報は、同意を得てからでないと取得できないようにする。
--
-- 「読んでもらう側」として登録することは、その人に視覚の障害がある、または
-- 見えにくさがある可能性を示す。個人情報保護法では、障害に関する情報は
-- 要配慮個人情報に当たり、取得には本人の事前の同意が要る。
-- それまでは、役割を選んだ瞬間に profiles.role = 'requester' を保存していた
-- （同意を得る前に取得していた）。
--
-- ここでは次を DB 側で強制する:
--   * 役割は register_role からしか書けない。register_role は同意の記録と
--     役割の保存を1つの処理で行い、依頼者なら要配慮個人情報への同意が無いと断る
--   * 文書の版が上がったら、同意し直すまで依頼を立てられない・取れない
--
-- 文書の本文は app/src/legal/documents.ts（docs/ に同じものを生成している）。
-- 版を上げるときは、そちらと current_consent_version() の両方を変える。

-- ------------------------------------------------------------- 同意の記録
create table consents (
  -- 同意は役割（profiles）より先に要るので、auth.users に紐づける
  user_id   uuid        not null references auth.users(id) on delete cascade,
  document  text        not null check (document in ('terms', 'privacy', 'sensitive')),
  version   text        not null,
  agreed_at timestamptz not null default now(),
  primary key (user_id, document, version)
);

alter table consents enable row level security;

create policy "自分の同意の記録は読める"
  on consents for select using (user_id = auth.uid());

create policy "運営は同意の記録を読める"
  on consents for select using (is_admin(auth.uid()));

-- 書くのは register_role / reconsent だけ（security definer）
revoke insert, update, delete on consents from authenticated, anon;

-- 今の版。文書を改めたらここを上げる（アプリの documents.ts と揃える）
create or replace function current_consent_version(p_document text)
returns text language sql immutable as $$
  select case p_document
    when 'terms'     then '2026-09-26'
    when 'privacy'   then '2026-09-26'
    when 'sensitive' then '2026-09-26'
  end;
$$;

-- その役割で要る同意が、今の版ですべて揃っているか
create or replace function has_current_consents(uid uuid, p_role user_role)
returns boolean language sql stable security definer set search_path = public as $$
  select
        exists (select 1 from consents where user_id = uid and document = 'terms'
                   and version = current_consent_version('terms'))
    and exists (select 1 from consents where user_id = uid and document = 'privacy'
                   and version = current_consent_version('privacy'))
    and (p_role <> 'requester'
         or exists (select 1 from consents where user_id = uid and document = 'sensitive'
                       and version = current_consent_version('sensitive')));
$$;

-- アプリが起動時に見る。足りない同意を返す（空なら何も要らない）
create or replace function my_missing_consents()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d.document order by d.document), '{}')
    from profiles p
    cross join lateral unnest(
      case when p.role = 'requester' then array['terms', 'privacy', 'sensitive']
           else array['terms', 'privacy'] end
    ) as d(document)
   where p.id = auth.uid()
     and not exists (
       select 1 from consents c
        where c.user_id = p.id and c.document = d.document
          and c.version = current_consent_version(d.document)
     );
$$;

grant execute on function my_missing_consents() to authenticated;

-- ------------------------------------------------ 役割は同意と一緒にだけ書ける
revoke insert, update on profiles from authenticated;
-- 表示名と言語は本人が変えてよい。役割・運営・利用停止は変えられない
grant update (display_name, language) on profiles to authenticated;

create or replace function register_role(
  p_role         user_role,
  p_display_name text,
  p_terms        text,
  p_privacy      text,
  p_sensitive    text default null
)
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := auth.uid();
  saved profiles;
begin
  if me is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- 古い版の文書を見て同意した（アプリが古い）なら断る。
  -- 読んでいない版に同意したことにしない。
  if p_terms is distinct from current_consent_version('terms')
     or p_privacy is distinct from current_consent_version('privacy') then
    raise exception 'CONSENT_VERSION_MISMATCH' using errcode = '22023';
  end if;

  -- 依頼者として登録すること自体が要配慮個人情報の取得になる。同意が無ければ断る
  if p_role = 'requester'
     and p_sensitive is distinct from current_consent_version('sensitive') then
    raise exception 'SENSITIVE_CONSENT_REQUIRED' using errcode = '42501';
  end if;

  insert into consents (user_id, document, version) values
    (me, 'terms',   p_terms),
    (me, 'privacy', p_privacy)
  on conflict do nothing;

  if p_role = 'requester' then
    insert into consents (user_id, document, version)
         values (me, 'sensitive', p_sensitive)
    on conflict do nothing;
  end if;

  insert into profiles (id, role, display_name, language)
       values (me, p_role, left(coalesce(p_display_name, ''), 40), 'ja')
  on conflict (id) do update
       set role = excluded.role,
           display_name = case when excluded.display_name = '' then profiles.display_name
                               else excluded.display_name end
  returning * into saved;

  if p_role = 'volunteer' then
    insert into volunteer_status (user_id, is_available, language)
         values (me, false, 'ja')
    on conflict (user_id) do nothing;
  end if;

  return saved;
end;
$$;

grant execute on function register_role(user_role, text, text, text, text) to authenticated;

-- 文書の版が上がったときの同意し直し。役割は変えない
create or replace function reconsent(p_terms text, p_privacy text, p_sensitive text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  role_now user_role;
begin
  select role into role_now from profiles where id = auth.uid();
  if role_now is null then
    raise exception 'NO_PROFILE' using errcode = '02000';
  end if;
  perform register_role(role_now, '', p_terms, p_privacy, p_sensitive);
end;
$$;

grant execute on function reconsent(text, text, text) to authenticated;

-- ------------------------------------------- 同意が揃うまで、依頼は立てられない
create or replace function enforce_request_limits()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  recent  integer;
  per_day integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('help_requests:' || new.requester_id::text));

  if exists (select 1 from profiles where id = new.requester_id and is_blocked) then
    raise exception 'REQUESTER_BLOCKED' using errcode = '42501';
  end if;

  -- 文書の版が上がったら、同意し直すまで依頼できない
  if not has_current_consents(new.requester_id, 'requester') then
    raise exception 'CONSENT_REQUIRED' using errcode = '42501';
  end if;

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

-- ------------------------------ 同意が揃うまで、ボランティアは待機列に入れない
-- 待機列の閲覧・依頼の取得・着信の宛先は、すべてこの判定を通る
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
  ) and has_current_consents(uid, 'volunteer');
$$;

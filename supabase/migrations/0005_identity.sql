-- 本人確認。承認の判断材料を作る。
--
-- 個人番号（マイナンバー）は保存しない。
--   番号法20条により、個人番号の収集・保管は社会保障・税・災害対策の
--   事務に限られる。ボランティアのマッチングはどれにも当たらないので、
--   取得した時点で違法になる。
--   マイナンバーカードは「本人確認書類」としては使えるため、
--   表面（氏名・住所・生年月日・顔写真）だけを受け取り、
--   個人番号が印字された裏面は受け取らない。
--
-- 書類番号（免許証番号など）も保存しない。
--   審査に必要なのは「本人かどうか」であって番号ではない。
--   持たなければ漏れない。

create or replace function is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = uid and is_admin);
$$;

create type id_document_kind as enum (
  'drivers_license',  -- 運転免許証（表・裏）
  'my_number_card',   -- マイナンバーカード（表面のみ）
  'passport',
  'residence_card'    -- 在留カード
);

create type identity_state as enum ('submitted', 'approved', 'rejected');

create table identity_verifications (
  id            uuid           primary key default gen_random_uuid(),
  user_id       uuid           not null references profiles(id) on delete cascade,
  kind          id_document_kind not null,

  -- 画像そのものは Storage に置き、ここにはパスだけ持つ。
  -- パスは必ず <user_id>/... で始まる（submit_identity が確かめる）。
  front_path    text           not null,
  back_path     text,
  -- 書類の顔写真と本人が一致するかを見るための自撮り。
  -- これが無いと、拾った免許証の写真で通ってしまう。
  selfie_path   text           not null,

  state         identity_state not null default 'submitted',
  submitted_at  timestamptz    not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid           references profiles(id),
  reject_reason text           not null default '',

  -- 審査が済んだ画像をいつ消すか。持ち続ける理由が無い。
  purge_after   timestamptz,

  -- マイナンバーカードの裏面は受け取らない
  constraint my_number_card_is_front_only
    check (kind <> 'my_number_card' or back_path is null)
);

create index identity_user_idx  on identity_verifications (user_id, submitted_at desc);
create index identity_state_idx on identity_verifications (state, submitted_at);

-- 審査待ちを同時に何件も積めないようにする
create unique index identity_one_open_per_user
  on identity_verifications (user_id)
  where state = 'submitted';

create index identity_purge_idx
  on identity_verifications (purge_after)
  where purge_after is not null;

-- ------------------------------------------------------------- 提出する
create or replace function submit_identity(
  p_kind   id_document_kind,
  p_front  text,
  p_selfie text,
  p_back   text default null
)
returns identity_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text := auth.uid()::text || '/';
  saved  identity_verifications;
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- 他人のフォルダのパスを差し込ませない。
  -- Storage 側のポリシーでも弾いているが、行だけ書き換えて
  -- 他人の画像を自分の審査に見せかける余地を消す。
  if p_front not like prefix || '%'
     or p_selfie not like prefix || '%'
     or (p_back is not null and p_back not like prefix || '%') then
    raise exception 'PATH_NOT_OWNED' using errcode = '42501';
  end if;

  if p_kind = 'my_number_card' and p_back is not null then
    raise exception 'MY_NUMBER_BACK_NOT_ACCEPTED' using errcode = '22023';
  end if;

  insert into identity_verifications (user_id, kind, front_path, back_path, selfie_path)
       values (auth.uid(), p_kind, p_front, p_back, p_selfie)
  returning * into saved;

  return saved;
end;
$$;

grant execute on function submit_identity(id_document_kind, text, text, text) to authenticated;

-- ------------------------------------------------------------- 審査する
create or replace function review_identity(
  p_id      uuid,
  p_approve boolean,
  p_reason  text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin(auth.uid()) then
    raise exception 'NOT_AN_ADMIN' using errcode = '42501';
  end if;

  update identity_verifications
     set state         = case when p_approve then 'approved' else 'rejected' end::identity_state,
         reviewed_at   = now(),
         reviewed_by   = auth.uid(),
         reject_reason = left(coalesce(p_reason, ''), 500),
         -- 審査が終われば画像を持つ理由は無い。
         -- 却下の場合だけ、問い合わせに答えられるよう少し長く置く。
         purge_after   = now() + case when p_approve then interval '7 days'
                                                     else interval '30 days' end
   where id = p_id
     and state = 'submitted';

  if not found then
    raise exception 'NOT_FOUND_OR_ALREADY_REVIEWED' using errcode = '02000';
  end if;
end;
$$;

grant execute on function review_identity(uuid, boolean, text) to authenticated;

-- ------------------------------ 本人確認が済むまでボランティアを承認しない
create or replace function review_volunteer(p_user uuid, p_state volunteer_review_state)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(auth.uid()) then
    raise exception 'NOT_AN_ADMIN' using errcode = '42501';
  end if;

  -- 承認するときだけ本人確認を要求する。停止や却下は常にできないと、
  -- 問題が起きたときに止められない。
  if p_state = 'approved' and not exists (
       select 1 from identity_verifications
        where user_id = p_user and state = 'approved'
     ) then
    raise exception 'IDENTITY_NOT_VERIFIED' using errcode = '42501';
  end if;

  update volunteer_status
     set review_state = p_state, reviewed_at = now(), reviewed_by = auth.uid()
   where user_id = p_user;

  if p_state <> 'approved' then
    update volunteer_status set is_available = false where user_id = p_user;
  end if;
end;
$$;

-- --------------------------------------------- 期限が来た画像を洗い出す
-- 実際の削除は Storage API を叩く必要があるので Edge Function 側で行う。
-- ここは「何を消すか」だけを返す。
create or replace function identity_documents_to_purge()
returns table (id uuid, paths text[])
language sql
security definer
set search_path = public
as $$
  select v.id,
         array_remove(array[v.front_path, v.back_path, v.selfie_path], null)
    from identity_verifications v
   where v.purge_after is not null
     and v.purge_after < now()
     and v.front_path <> '';
$$;

-- 画像を消したあと、行から参照を落とす。審査の結果だけ残す。
create or replace function mark_identity_purged(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update identity_verifications
     set front_path = '', back_path = null, selfie_path = '', purge_after = null
   where id = p_id;
$$;

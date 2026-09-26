-- 退会。
--
-- 退会すると、アカウント・役割・依頼の記録・通報・ブロック・同意の記録・
-- 本人確認書類の画像を消す（auth.users を消せば cascade で消える。
-- 画像は Storage にあるので delete-account が消す）。
--
-- ただし、不正な再登録を防ぐために2つだけ残す（プライバシーポリシーに記載）:
--   * 書類の識別子（氏名＋生年月日の HMAC。元に戻せない）
--   * 利用が止められていたかどうか
-- これだけでは、その人が誰かは分からない。
-- 残さないと、利用停止になった人が退会して、同じ書類で作り直せば元に戻れてしまう。
--
-- App Store は、アカウントを作れるアプリにアプリ内での削除を求めている。

create table retired_fingerprints (
  fingerprint   text        primary key,
  was_suspended boolean     not null default false,
  retired_at    timestamptz not null default now()
);

-- 誰にも読ませない・書かせない（ポリシーを作らない。service role だけが触る）
alter table retired_fingerprints enable row level security;
revoke all on retired_fingerprints from authenticated, anon;

-- 退会の前処理。識別子と「止められていたか」を控える。呼ぶのは delete-account だけ
create or replace function retire_account(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  suspended boolean;
  kept      integer;
begin
  select coalesce(p.is_blocked, false) or coalesce(v.review_state = 'suspended', false)
    into suspended
    from profiles p
    left join volunteer_status v on v.user_id = p.id
   where p.id = p_user;

  insert into retired_fingerprints (fingerprint, was_suspended)
  select distinct c.fingerprint, coalesce(suspended, false)
    from document_checks c
    join identity_verifications iv on iv.id = c.verification_id
   where iv.user_id = p_user
     and c.fingerprint is not null
  on conflict (fingerprint) do update
     -- 一度でも止められていたら、その印は消さない
     set was_suspended = retired_fingerprints.was_suspended or excluded.was_suspended,
         retired_at    = now();

  get diagnostics kept = row_count;
  return kept;
end;
$$;

revoke execute on function retire_account(uuid) from public, anon, authenticated;
grant execute on function retire_account(uuid) to service_role;

-- 自動チェックの記録に、退会した人の書類との照合を足す
create or replace function record_document_check(
  p_verification uuid,
  p_fingerprint  text,
  p_flags        text[],
  p_details      jsonb
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  owner   uuid;
  final   text[] := coalesce(p_flags, '{}');
  retired retired_fingerprints;
begin
  select user_id into owner from identity_verifications where id = p_verification;
  if owner is null then
    raise exception 'VERIFICATION_NOT_FOUND' using errcode = '02000';
  end if;

  if p_fingerprint is not null then
    -- 今あるアカウントの書類と一致
    if exists (select 1 from documents_with_fingerprint(p_fingerprint, owner)) then
      final := array_append(final, 'duplicate_document');
    end if;

    -- 退会したアカウントの書類と一致。止められていた人なら、なおさら
    select * into retired from retired_fingerprints where fingerprint = p_fingerprint;
    if found then
      final := array_append(final,
        case when retired.was_suspended then 'from_suspended_account'
             else 'reused_after_deletion' end);
    end if;
  end if;

  insert into document_checks (verification_id, fingerprint, flags, details)
       values (p_verification, p_fingerprint, final, coalesce(p_details, '{}'::jsonb))
  on conflict (verification_id) do update
       set fingerprint = excluded.fingerprint,
           flags       = excluded.flags,
           details     = excluded.details,
           checked_at  = now();

  return final;
end;
$$;

revoke execute on function record_document_check(uuid, text, text[], jsonb) from public, anon, authenticated;
grant execute on function record_document_check(uuid, text, text[], jsonb) to service_role;

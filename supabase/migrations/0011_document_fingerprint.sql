-- 書類の使い回しの検出を、知覚ハッシュから「書類の識別子」に替える。
--
-- 以前は券面画像の知覚ハッシュ（pHash）のハミング距離が 6 以下なら使い回しと
-- していた。ところが様式が同じ書類（運転免許証どうし等）は、別人でも
-- 距離が 2〜6 になった（見本画像で実際に確かめた）。pHash が捉えるのは
-- 「見た目の様式」で「誰の書類か」ではないため、ほぼすべての免許証が
-- 誰かの使い回しと判定される状態だった。
--
-- 今は OCR サーバが、券面から読んだ氏名と生年月日を、サーバだけが持つ鍵で
-- HMAC にした識別子を返す。同じ人の同じ書類なら撮り直しても一致し、
-- 別人なら一致しない。氏名と生年月日そのものはどこにも残らない。

alter table document_checks add column fingerprint text;
alter table document_checks drop column phash_front;

create index document_checks_fingerprint_idx
  on document_checks (fingerprint)
  where fingerprint is not null;

drop function if exists similar_documents(bit(64), uuid, integer);
drop function if exists record_document_check(uuid, text, text[], jsonb);

-- 同じ識別子の書類を、別のアカウントの提出から探す
create or replace function documents_with_fingerprint(p_fingerprint text, p_exclude_user uuid)
returns table (verification_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.verification_id, v.user_id
    from document_checks c
    join identity_verifications v on v.id = c.verification_id
   where c.fingerprint = p_fingerprint
     and v.user_id <> p_exclude_user;
$$;

-- 呼ぶのは inspect-identity（service role）だけ
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
  owner uuid;
  final text[] := coalesce(p_flags, '{}');
begin
  select user_id into owner from identity_verifications where id = p_verification;
  if owner is null then
    raise exception 'VERIFICATION_NOT_FOUND' using errcode = '02000';
  end if;

  -- 使い回しは、書類が本物かどうかとは別の問題として立てる。
  -- 本物の免許証を家族から借りている場合もここに出る。
  if p_fingerprint is not null
     and exists (select 1 from documents_with_fingerprint(p_fingerprint, owner)) then
    final := array_append(final, 'duplicate_document');
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
revoke execute on function documents_with_fingerprint(text, uuid) from public, anon, authenticated;

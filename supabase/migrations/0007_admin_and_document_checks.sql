-- 運営が審査するための土台と、自動チェックの結果置き場。
--
-- 自動チェックは「判定」ではなく「人が見るための材料」として扱う。
-- 書類の真贋を機械が断定できるという前提で作ると、
-- 見逃したときに誰も気づかない仕組みになる。

-- ------------------------------------------------- 運営は全件読める
-- 既存の「自分の分だけ」ポリシーに OR で足す形になる。
create policy "運営は全員のプロフィールを読める"
  on profiles for select using (is_admin(auth.uid()));

create policy "運営は全員の待機状態を読める"
  on volunteer_status for select using (is_admin(auth.uid()));

create policy "運営はすべての通報を読める"
  on reports for select using (is_admin(auth.uid()));

-- ------------------------------------------------- 自動チェックの結果
create table document_checks (
  verification_id uuid primary key
                    references identity_verifications(id) on delete cascade,

  -- 画像そのものは審査後に消すが、知覚ハッシュは残す。
  -- 「同じ書類が別のアカウントで再利用された」を後から検出するのに要る。
  -- 元画像は復元できない。
  phash_front     bit(64),

  -- 引っかかった項目。人が最初に見る場所。
  flags           text[]      not null default '{}',
  -- OCR で読めた語、有効期限、顔の数など。判断の根拠を残す。
  details         jsonb       not null default '{}'::jsonb,
  checked_at      timestamptz not null default now()
);

alter table document_checks enable row level security;

create policy "運営は自動チェックを読める"
  on document_checks for select using (is_admin(auth.uid()));

create policy "本人は自分の自動チェックを読める"
  on document_checks for select using (
    exists (
      select 1 from identity_verifications v
       where v.id = verification_id and v.user_id = auth.uid()
    )
  );

-- ----------------------------------------- 同じ書類の使い回しを探す
-- ハミング距離で近いものを返す。完全一致だけを見ると、
-- 撮り直し・トリミング・圧縮で別物になってすり抜ける。
create or replace function similar_documents(
  p_phash        bit(64),
  p_exclude_user uuid,
  p_max_distance integer default 6
)
returns table (verification_id uuid, user_id uuid, distance integer)
language sql
stable
security definer
set search_path = public
as $$
  select c.verification_id,
         v.user_id,
         bit_count(c.phash_front # p_phash)::integer
    from document_checks c
    join identity_verifications v on v.id = c.verification_id
   where c.phash_front is not null
     and v.user_id <> p_exclude_user
     and bit_count(c.phash_front # p_phash) <= p_max_distance
   order by 3;
$$;

-- ------------------------------------------- チェック結果を書き込む
-- 呼ぶのは inspect-identity（service role）だけ。
-- 本人にもボランティアにも書かせない。
create or replace function record_document_check(
  p_verification uuid,
  p_phash        text,
  p_flags        text[],
  p_details      jsonb
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  hash      bit(64);
  owner     uuid;
  dup_count integer := 0;
  final     text[] := coalesce(p_flags, '{}');
begin
  select user_id into owner from identity_verifications where id = p_verification;
  if owner is null then
    raise exception 'VERIFICATION_NOT_FOUND' using errcode = '02000';
  end if;

  if p_phash is not null and length(p_phash) = 64 then
    hash := p_phash::bit(64);

    select count(*) into dup_count
      from similar_documents(hash, owner);

    -- 使い回しは、書類が本物かどうかとは別の問題として立てる。
    -- 本物の免許証を他人から借りている場合もここに出る。
    if dup_count > 0 then
      -- array_append を使う。final || 'literal' と書くと、
      -- 型の付いていないリテラルが配列として解釈されて
      -- malformed array literal で落ちる。
      final := array_append(final, 'duplicate_document');
    end if;
  end if;

  insert into document_checks (verification_id, phash_front, flags, details)
       values (p_verification, hash, final, coalesce(p_details, '{}'::jsonb))
  on conflict (verification_id) do update
       set phash_front = excluded.phash_front,
           flags       = excluded.flags,
           details     = excluded.details,
           checked_at  = now();

  return final;
end;
$$;

revoke execute on function record_document_check(uuid, text, text[], jsonb) from public, anon, authenticated;
grant execute on function record_document_check(uuid, text, text[], jsonb) to service_role;

-- ------------------------------------------------- 通報を処理済みにする
create or replace function handle_report(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(auth.uid()) then
    raise exception 'NOT_AN_ADMIN' using errcode = '42501';
  end if;

  update reports
     set handled_at = now(), handled_by = auth.uid()
   where id = p_id and handled_at is null;
end;
$$;

grant execute on function handle_report(uuid) to authenticated;

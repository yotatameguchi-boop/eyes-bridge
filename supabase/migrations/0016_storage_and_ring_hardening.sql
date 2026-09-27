-- セキュリティチェックで実際に通った攻撃を塞ぐ（その2）。
--
-- 1. 本人確認書類のすり替え
--    提出したあとに、本人が書類の画像を消して、同じ場所に別の画像を置けた。
--    自動チェックは元の画像で行われ、運営はすり替えた画像を審査することになる。
--    画像以外（HTML など）も、どんな大きさでも置けた。
--
-- 2. 使い捨てアカウントでの着信の連打
--    依頼の数の上限は1アカウントあたりなので、アカウントを大量に作れば
--    同じボランティアを何度も鳴らせる。アカウント作成側（メールの確認）も締めるが、
--    鳴らされる側でも上限を持つ：1人のボランティアを鳴らすのは1時間に12回まで。

-- ---------------------------------------------------- 1. 書類置き場
-- 本人は置けるが、消せない（上書きもできない。update のポリシーは元から無い）。
-- 消すのは運営と、service role で動く削除処理（purge / 退会）だけ。
drop policy "本人確認書類は本人と運営が消せる" on storage.objects;

create policy "本人確認書類は運営だけが消せる"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'identity-documents'
    and private.is_admin(auth.uid())
  );

-- 画像だけ、10MB まで（アプリは JPEG を送る。iPhone の HEIC も受ける）
update storage.buckets
   set file_size_limit    = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/heic', 'image/heif']
 where id = 'identity-documents';

-- ---------------------------------------- 2. 1人を鳴らす回数の上限
create or replace function take_ring_wave(
  p_request uuid,
  p_wave    integer,
  p_limit   integer,
  p_now     timestamptz default now()
)
returns table (user_id uuid, push_token text, push_kind text)
language plpgsql
security definer
set search_path = public, private
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
       -- 1時間に12回まで。使い捨てアカウントを大量に作られても、
       -- 同じ人の電話を鳴らし続けることはできない
       and (select count(*) from request_rings r
             where r.user_id = v.user_id and r.rung_at > p_now - interval '1 hour') < 12
     order by v.last_seen_at desc
     limit p_limit
  ), recorded as (
    insert into request_rings (request_id, user_id, wave, rung_at)
    select p_request, picked.user_id, p_wave, p_now from picked
    returning request_rings.user_id
  )
  select picked.user_id, picked.push_token, picked.push_kind
    from picked
    join recorded on recorded.user_id = picked.user_id;
end;
$$;

create index if not exists request_rings_user_recent_idx on request_rings (user_id, rung_at desc);

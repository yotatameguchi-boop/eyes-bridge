-- 本人確認書類は「本人と運営だけ」。
-- 画像は DB ではなく Storage に置くので、両方に同じ線を引く。

alter table identity_verifications enable row level security;

create policy "自分の本人確認と、運営は全件読める"
  on identity_verifications for select using (
    user_id = auth.uid() or is_admin(auth.uid())
  );

-- insert / update のポリシーは作らない。
-- 提出は submit_identity、審査は review_identity（どちらも security definer）だけ。
-- 直接 insert させると、state = 'approved' で自分の行を作れてしまう。

-- ------------------------------------------------------------- Storage
insert into storage.buckets (id, name, public)
     values ('identity-documents', 'identity-documents', false)
on conflict (id) do nothing;

alter table storage.objects enable row level security;

-- 置けるのは自分の user_id のフォルダの中だけ
create policy "本人確認書類は自分のフォルダにだけ置ける"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'identity-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "本人確認書類は本人と運営だけ読める"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'identity-documents'
    and ((storage.foldername(name))[1] = auth.uid()::text or is_admin(auth.uid()))
  );

create policy "本人確認書類は本人と運営が消せる"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'identity-documents'
    and ((storage.foldername(name))[1] = auth.uid()::text or is_admin(auth.uid()))
  );

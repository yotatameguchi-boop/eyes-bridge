-- 待機列の知らせを Broadcast で配る。
--
-- それまでは、待機中のボランティアがそれぞれ help_requests の変更を
-- 購読していた（postgres_changes）。この方式は、変更が1件あるたびに
-- 購読者一人ひとりについて閲覧権限を確かめるので、待機中の人数が増えると重くなる。
-- 今は、変更を DB から1回だけ Broadcast で配り、受け取れる人は
-- realtime.messages の権限で「承認済みのボランティア」に絞る。
--
-- あわせて、取られた・取り下げられた依頼の知らせ（request_closed）も配る。
-- 以前は他の人が取った依頼が一覧に残り続け、受けようとして初めて
-- 「ほかの人が対応しました」と分かる作りだった。
--
-- realtime.send は Supabase の Postgres にしか無い。素の Postgres
-- （テストと docker compose の db）では何もせずに通す。

do $outer$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'realtime' and p.proname = 'send'
  ) then
    raise notice 'realtime.send が無いので、待機列の Broadcast は設定しない（素の Postgres）';
    return;
  end if;

  create or replace function public.broadcast_queue_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  begin
    -- 中身は最小限。誰の依頼かは配らない（一覧に出すのに要らない）
    if tg_op = 'INSERT' and new.state = 'queued' then
      perform realtime.send(
        jsonb_build_object('id', new.id, 'created_at', new.created_at, 'language', new.language),
        'request_queued',
        'queue:' || new.language,
        true  -- 非公開。受け取れる人は下のポリシーで決める
      );
    elsif tg_op = 'UPDATE' and old.state = 'queued' and new.state <> 'queued' then
      perform realtime.send(
        jsonb_build_object('id', new.id, 'state', new.state),
        'request_closed',
        'queue:' || new.language,
        true
      );
    end if;
    return null;
  end;
  $fn$;

  drop trigger if exists help_requests_broadcast on public.help_requests;
  create trigger help_requests_broadcast
    after insert or update of state on public.help_requests
    for each row execute function public.broadcast_queue_change();

  -- 待機列の知らせを受け取れるのは、承認済みのボランティアだけ
  -- （ポリシー名は 63 バイトまで。日本語は1文字3バイトなので短くしてある）
  -- （同意が今の版で揃っていることも is_approved_volunteer が見ている）
  drop policy if exists "待機列の知らせは承認済みボランティアだけ" on realtime.messages;
  create policy "待機列の知らせは承認済みボランティアだけ"
    on realtime.messages
    for select
    to authenticated
    using (
      realtime.topic() like 'queue:%'
      and extension = 'broadcast'
      and public.is_approved_volunteer(auth.uid())
    );
end
$outer$;

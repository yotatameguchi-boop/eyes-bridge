-- 定期実行。これまで README に「pg_cron から叩く想定」と書いただけで、
-- 実際にはどこからも呼ばれていなかった。
--
--   * 誰も取らなかった依頼を時間切れにする         … 毎分
--   * 承認が外れた人を待機から降ろす               … 5分ごと
--   * 審査済みの本人確認書類の画像を Storage から消す … 毎日 3:17
--
-- pg_cron / pg_net / vault は Supabase の Postgres にしか無い。
-- 素の Postgres（テストと docker compose の db）では何もせずに通す。

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron が無いので定期実行は登録しない（素の Postgres）';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;

  -- 同じ名前で登録し直すと上書きになるので、何度流しても増えない
  perform cron.schedule(
    'expire-stale-requests',
    '* * * * *',
    $$select public.expire_stale_requests()$$
  );

  perform cron.schedule(
    'drop-unapproved-from-standby',
    '*/5 * * * *',
    $$select public.drop_unapproved_from_standby()$$
  );

  -- 画像の削除は Storage API を叩く必要があるので Edge Function 経由。
  -- URL と service role キーはマイグレーションに書かない（公開リポジトリなので）。
  -- 運用開始時に一度だけ Vault に入れてもらう（README 参照）。
  -- 未設定の間は URL が null になり、呼び出しは何もせず失敗する。
  perform cron.schedule(
    'purge-identity-documents',
    '17 3 * * *',
    $$
      select net.http_post(
        url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
                   || '/functions/v1/purge-identity-documents',
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                                     where name = 'service_role_key')
                   ),
        body    := '{}'::jsonb
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'project_url');
    $$
  );
end
$outer$;

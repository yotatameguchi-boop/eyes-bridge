-- 関数の実行権限を締める。
--
-- セキュリティチェックで、ログインしていない人（anon キーだけ）が次のことを
-- できると分かった（手元の Supabase で実際に通った）:
--   * expire_stale_requests('0 seconds') で、待っている依頼を全部時間切れにする
--     → 繰り返せば、誰もボランティアにつながらなくなる
--   * identity_documents_to_purge() で、本人確認書類の保存場所を抜き出す
--   * mark_identity_purged(id) で書類への参照を消す
--     → 運営が審査できなくなり、画像は削除の対象から外れて残り続ける
--   * is_admin / blocked_between で、誰が運営か・誰と誰がブロックし合っているかを調べる
--
-- 原因は、関数は作った時点で「誰でも実行できる」権限が付くのに、それを外していなかったこと。
-- ここでは「許したものだけ通す」に切り替える:
--   * anon は、公開している関数を1つも実行できない
--   * ログインした利用者は、アプリが使う関数（下の一覧）だけ
--   * それ以外（定期実行・Edge Function の内部処理）は service role だけ
--   * 権限の判定に使う関数は、API に公開していない private スキーマに移す
--     （RLS の中からは今までどおり使える。API からは呼べない）

-- ------------------------------------------------ 判定用の関数を非公開の場所へ
create schema if not exists private;
revoke all on schema private from public;
-- RLS の判定は問い合わせた人の権限で走るので、使えるようにはしておく（API には出ない）
grant usage on schema private to anon, authenticated, service_role;

alter function public.is_admin(uuid)                        set schema private;
alter function public.is_approved_volunteer(uuid)           set schema private;
alter function public.blocked_between(uuid, uuid)           set schema private;
alter function public.has_current_consents(uuid, user_role) set schema private;

-- RLS のポリシーは関数を ID で覚えているので、移しても今までどおり動く。
-- 関数の本体は名前で呼んでいるので、探す場所に private を足す
alter function private.is_approved_volunteer(uuid)                          set search_path = public, private;
alter function public.handle_report(uuid)                                   set search_path = public, private;
alter function public.review_identity(uuid, boolean, text)                  set search_path = public, private;
alter function public.review_volunteer(uuid, volunteer_review_state)        set search_path = public, private;
alter function public.set_user_blocked(uuid, boolean)                       set search_path = public, private;
alter function public.claim_help_request(uuid)                              set search_path = public, private;
alter function public.take_ring_wave(uuid, integer, integer, timestamptz)   set search_path = public, private;
alter function public.enforce_request_limits()                              set search_path = public, private;

-- ------------------------------------------- 公開の関数は「許したものだけ」
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- ログインした利用者がアプリから呼ぶもの（これ以外は呼べない）
grant execute on function public.agree_to_terms()                                         to authenticated;
grant execute on function public.claim_help_request(uuid)                                 to authenticated;
grant execute on function public.consume_ocr_quota()                                      to authenticated;
grant execute on function public.end_help_request(uuid, request_state)                    to authenticated;
grant execute on function public.handle_report(uuid)                                      to authenticated;
grant execute on function public.mark_request_rung(uuid)                                  to authenticated;
grant execute on function public.my_missing_consents()                                    to authenticated;
grant execute on function public.reconsent(text, text, text)                              to authenticated;
grant execute on function public.register_role(user_role, text, text, text, text)         to authenticated;
grant execute on function public.report_participant(uuid, report_reason, text, boolean)   to authenticated;
grant execute on function public.review_identity(uuid, boolean, text)                     to authenticated;
grant execute on function public.review_volunteer(uuid, volunteer_review_state)           to authenticated;
grant execute on function public.set_user_blocked(uuid, boolean)                          to authenticated;
grant execute on function public.submit_identity(id_document_kind, text, text, text)      to authenticated;

-- これから作る関数にも、誰でも実行できる権限が付かないようにする。
-- 「誰でも（PUBLIC）実行できる」は全体の既定なので、スキーマ単位の指定では取り消せない
-- （スキーマ単位の指定は、全体の既定に「足す」ことしかできない）。全体で取り消す。
-- 最初はスキーマ単位でしか書いておらず、テストで関数を足したら、それが
-- ログインしていない人から呼べる状態になっていた（exposure_test が捕まえた）
alter default privileges revoke execute on functions from public;
-- anon / authenticated への付与は Supabase がスキーマ単位で入れているので、スキーマ単位で外す
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

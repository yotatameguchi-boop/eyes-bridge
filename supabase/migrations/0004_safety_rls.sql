-- 審査・通報・ブロックを RLS と列権限で実際に効かせる。
-- 関数を足しただけでは、クライアントがテーブルを直接叩けば素通りする。

-- ------------------------------------------- 待機列は承認済みにしか見せない
drop policy "依頼は当事者と待機中の行だけ見える" on help_requests;

create policy "依頼は当事者と承認済みボランティアだけ"
  on help_requests for select using (
        requester_id = auth.uid()
     or volunteer_id = auth.uid()
     or (
          state = 'queued'
      and is_approved_volunteer(auth.uid())
      and not blocked_between(requester_id, auth.uid())
        )
  );

drop function if exists is_volunteer(uuid);

-- ------------------------------------------------------------- 通報
alter table reports enable row level security;

-- 読めるのは自分が出した通報だけ。誰に通報されたかは本人に見せない
-- （報復を防ぐため）。
create policy "自分が出した通報は読める"
  on reports for select using (reporter_id = auth.uid());

-- insert のポリシーは意図的に作らない。
-- 通報は report_participant（security definer）だけが立てられる。
-- 直接 insert させると、当事者でない通話の通報を捏造できてしまう。

-- ------------------------------------------------------------- ブロック
alter table blocks enable row level security;

create policy "自分のブロックは読める"
  on blocks for select using (blocker_id = auth.uid());

create policy "自分のブロックは作れる"
  on blocks for insert with check (blocker_id = auth.uid());

create policy "自分のブロックは外せる"
  on blocks for delete using (blocker_id = auth.uid());

-- --------------------------------------------- 自己承認を列権限で禁じる
--
-- RLS は「どの行を触れるか」しか制御しない。
-- 「自分の待機状態は更新できる」ポリシーがある以上、
-- review_state = 'approved' を自分で書き込めてしまう。
-- 列ごとに権限を切って、審査に関わる列はサーバ側の
-- security definer 関数からしか動かせないようにする。

revoke insert, update on volunteer_status from authenticated;

grant insert (user_id, is_available, push_token, push_kind, language, last_seen_at)
  on volunteer_status to authenticated;

grant update (is_available, push_token, push_kind, language, last_seen_at, updated_at)
  on volunteer_status to authenticated;

-- 同じ理由で is_admin / is_blocked を自分で立てられないようにする
revoke insert, update on profiles from authenticated;

grant insert (id, role, display_name, language) on profiles to authenticated;
grant update (role, display_name, language) on profiles to authenticated;

-- ------------------------------------------- 停止された人を待機から降ろす
-- 承認が外れた瞬間に is_available を false にするだけでは、
-- すでに開いている画面からは待機したままに見える。
-- 実際に列が見えなくなるのは RLS 側で保証されているので、
-- ここは掃除として扱う。
create or replace function drop_unapproved_from_standby()
returns integer language sql security definer set search_path = public as $$
  with dropped as (
    update volunteer_status
       set is_available = false, updated_at = now()
     where is_available
       and review_state <> 'approved'
    returning 1
  )
  select count(*)::int from dropped;
$$;

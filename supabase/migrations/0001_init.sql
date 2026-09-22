-- eyes-bridge: 視覚障害のある人と晴眼ボランティアを1対1で繋ぐ待機列
--
-- 設計方針:
--   * 映像・音声は一切 DB に入れない。LiveKit を素通りさせ、録画もしない。
--   * 依頼の本文も持たない。「誰が・いつ・どれくらい繋がったか」だけを残す。
--   * 取り合いは楽観ロックではなく UPDATE ... WHERE state='queued' の
--     単一文で解決する。最初に書けた1人が勝つ（Be My Eyes と同じ挙動）。

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles
create type user_role as enum ('requester', 'volunteer');

create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  role         user_role   not null,
  display_name text        not null default '',
  language     text        not null default 'ja',
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------- volunteer_status
-- Realtime Presence は「今この瞬間に画面を開いている人」しか分からない。
-- アプリを閉じている人を鳴らすために push_token をここに永続化する。
create table volunteer_status (
  user_id        uuid primary key references profiles(id) on delete cascade,
  is_available   boolean     not null default false,
  push_token     text,
  push_kind      text        not null default 'expo'  -- 'expo' | 'apns_voip' | 'fcm'
                 check (push_kind in ('expo', 'apns_voip', 'fcm')),
  language       text        not null default 'ja',
  accepted_count integer     not null default 0,
  last_seen_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index volunteer_status_ringable_idx
  on volunteer_status (language)
  where is_available and push_token is not null;

-- ----------------------------------------------------------- help_requests
create type request_state as enum (
  'queued',     -- 作られた直後。まだ誰も取っていない
  'active',     -- ボランティアが取って通話中
  'completed',  -- 通話が正常に終わった
  'cancelled',  -- 依頼者が切った
  'timed_out'   -- 誰も取らずに期限切れ
);

create table help_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid          not null references profiles(id) on delete cascade,
  volunteer_id uuid          references profiles(id) on delete set null,
  state        request_state not null default 'queued',
  language     text          not null default 'ja',
  -- 部屋名はサーバ側で決める。クライアントに決めさせると
  -- 他人の部屋名を推測して入室を試みる余地が残るため。
  room_name    text          not null unique default ('room_' || gen_random_uuid()),
  created_at   timestamptz   not null default now(),
  matched_at   timestamptz,
  ended_at     timestamptz
);

-- 待機列の読み出しはここしか叩かないので部分インデックスで十分
create index help_requests_queued_idx
  on help_requests (language, created_at)
  where state = 'queued';

create index help_requests_requester_idx on help_requests (requester_id, created_at desc);
create index help_requests_volunteer_idx on help_requests (volunteer_id, created_at desc);

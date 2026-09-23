#!/bin/bash
# Postgres の初回起動時に、stub とマイグレーションを順に当てる。
#
# stub は Supabase の auth スキーマと3つのロールを最小限だけ作る。
# auth.uid() は本物の Supabase と同じく JWT クレームの sub を読む。
# 手元で「誰として実行するか」を切り替えるには:
#
#   set role authenticated;
#   set request.jwt.claims = '{"sub":"<ユーザーID>"}';
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /stub/supabase_stub.sql

for f in /migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
done

echo "eyes-bridge: マイグレーション適用完了"

#!/bin/bash
# Postgres の初回起動時に、stub とマイグレーションを順に当てる。
#
# stub は Supabase の auth スキーマと3つのロールを最小限だけ作る。
# auth.uid() は本物では JWT から読むが、ここでは GUC app.uid から読む。
# 手元で「誰として実行するか」を切り替えられるようにするため:
#
#   set role authenticated;
#   set app.uid = '<ユーザーID>';
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /stub/supabase_stub.sql

for f in /migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
done

echo "eyes-bridge: マイグレーション適用完了"

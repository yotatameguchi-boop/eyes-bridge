#!/usr/bin/env bash
# マイグレーションを実際の Postgres に当てて、安全側の挙動を確かめる。
#
# Supabase を立てずに回せるよう、auth スキーマと anon/authenticated/service_role
# だけを stub で用意する。auth.uid() は GUC app.uid から読む差し替え版。
#
#   ./supabase/tests/run.sh                    # 一時クラスタを勝手に立てる
#   PGURL=postgres://... ./supabase/tests/run.sh   # 既存の DB を使う
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
owned_cluster=""

if [[ -z "${PGURL:-}" ]]; then
  tmp="$(mktemp -d)"
  data="$tmp/pgdata"
  # 空いているポートを取る。決め打ちだと、前回の後始末に失敗した
  # クラスタが残っていたときに起動できない。
  port="$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")"
  LC_ALL=C initdb -D "$data" -U postgres --no-sync -A trust >/dev/null
  LC_ALL=C pg_ctl -D "$data" -o "-h 127.0.0.1 -p $port" -l "$tmp/pg.log" -w start >/dev/null
  owned_cluster="$data"
  trap 'pg_ctl -D "$owned_cluster" stop -m immediate >/dev/null 2>&1 || true' EXIT
  PGURL="postgresql://postgres@127.0.0.1:$port/postgres"
fi

admin="$PGURL"
psql "$admin" -q -c "drop database if exists eb_test;" -c "create database eb_test;"
db="${admin%/*}/eb_test"

export PGOPTIONS='-c lc_messages=C'   # 判定をメッセージ文字列でするため英語に固定

psql "$db" -v ON_ERROR_STOP=1 -q -f "$here/supabase_stub.sql" 2>&1 | grep -vE "WARNING|HINT|NOTICE" || true
for f in "$root"/supabase/migrations/*.sql; do
  psql "$db" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | grep -vE "NOTICE" || true
done

out="$(psql "$db" -q -t -A -f "$here/safety_test.sql" 2>&1)"
echo "$out"

if grep -q "FAIL" <<<"$out"; then
  echo
  echo "テストが落ちました"
  exit 1
fi
echo
echo "すべて通りました"

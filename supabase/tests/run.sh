#!/usr/bin/env bash
# マイグレーションを実際の Postgres に当てて、安全側の挙動を確かめる。
#
# 2通りの流し方がある。
#
#   ./supabase/tests/run.sh
#       一時クラスタを立て、auth / storage スキーマを stub で用意して流す。
#       Supabase が無くても回るので速い。
#
#   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres ./supabase/tests/run.sh
#       `supabase start` で立てた本物の Supabase に流す。
#       マイグレーションは supabase 側で当たっている前提。
#       stub では再現しきれない差（テーブルの所有者、postgres が
#       superuser でないこと等）はこちらでしか出ない。
#       各テストは begin ... rollback で包むので、DB に何も残さない。
#
#   PGURL=postgres://... ./supabase/tests/run.sh
#       stub 方式で、既存のクラスタを使う。
#
# stub 方式ではテストファイルごとに DB を作り直す。共有すると、片方が入れた行が
# もう片方の件数の期待を壊し、実行順で結果が変わるようになる。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
owned_cluster=""

export PGOPTIONS='-c lc_messages=C'   # 判定をメッセージ文字列でするため英語に固定

# 1ファイル分の結果を判定する。
#
# 「FAIL が無い」だけで通すと、接続に失敗して何も走らなかったときにも
# 通ってしまう（実際にそうなった。接続エラーはクライアント側の言語で
# 出るので ERROR: を探すだけでは拾えない）。
# psql の終了コードと、PASS が1件以上あることの両方を見る。
judge() {
  local out="$1" status="$2"
  if [[ $status -ne 0 ]]; then
    echo "  → psql が異常終了した（終了コード $status）"
    return 1
  fi
  if grep -qE "FAIL|ERROR:|FATAL|エラー" <<<"$out"; then
    return 1
  fi
  if ! grep -q "^PASS" <<<"$out"; then
    echo "  → アサーションが1件も実行されなかった"
    return 1
  fi
  return 0
}

if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  # 本物の Supabase では postgres が superuser ではないので
  # lc_messages を変えられず、接続そのものが拒否される。
  # イメージ側が C ロケールなので、変えなくてもメッセージは英語になる。
  unset PGOPTIONS
  failed=0
  for test_file in "$here"/*_test.sql; do
    echo "== $(basename "$test_file" .sql)（本物の Supabase） =="
    status=0
    out="$({ echo "begin;"; cat "$test_file"; echo "rollback;"; } \
             | psql "$SUPABASE_DB_URL" -q -t -A 2>&1)" || status=$?
    echo "$out"
    judge "$out" "$status" || failed=1
  done
  echo
  if [[ $failed -ne 0 ]]; then echo "テストが落ちました"; exit 1; fi
  echo "すべて通りました"
  exit 0
fi

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

failed=0

for test_file in "$here"/*_test.sql; do
  name="$(basename "$test_file" .sql)"
  echo "== $name =="

  psql "$admin" -q -c "drop database if exists eb_$name;" -c "create database eb_$name;" 2>&1 \
    | grep -vE "NOTICE" || true
  db="${admin%/*}/eb_$name"

  psql "$db" -v ON_ERROR_STOP=1 -q -f "$here/supabase_stub.sql" 2>&1 \
    | grep -vE "WARNING|HINT|NOTICE" || true
  for f in "$root"/supabase/migrations/*.sql; do
    psql "$db" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | grep -vE "NOTICE" || true
  done

  # ERROR が出ても出力は必ず見せる。判定は judge に任せる。
  status=0
  out="$(psql "$db" -q -t -A -f "$test_file" 2>&1)" || status=$?
  echo "$out"
  judge "$out" "$status" || failed=1
done

echo
if [[ $failed -ne 0 ]]; then
  echo "テストが落ちました"
  exit 1
fi
echo "すべて通りました"

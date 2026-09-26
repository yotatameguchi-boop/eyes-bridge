"""自動チェックの単体テスト。

PaddleOCR のモデルを要求しない部分（知覚ハッシュ・日付の読み取り・
顔検出・旗の判定）だけを対象にする。OCR そのものの精度は
実際の書類でしか確かめられないので、ここでは扱わない。

コンテナに向けて流す（イメージに焼く必要はない）:

    docker compose exec -T ocr python - < ocr/test_inspection.py
"""

import sys
from datetime import date

import numpy as np

from inspection import count_faces, document_fingerprint, inspect, moire_score, parse_expiry

failures = 0


def ok(condition: bool, label: str) -> None:
    global failures
    if not condition:
        failures += 1
    print(("PASS  " if condition else "FAIL  ") + label)


rng = np.random.default_rng(0)
image = rng.integers(0, 255, (400, 640, 3), dtype=np.uint8)

# --- 使い回しを検出する識別子 ---------------------------------------
KEY = b"test-key"
hanako = ["運転免許証", "氏名　見本　花子", "生年月日　平成5年4月1日生", "東京都公安委員会"]
ichiro = ["運転免許証", "氏名　試験　一郎", "生年月日　昭和60年12月3日生", "東京都公安委員会"]

fp = document_fingerprint(hanako, KEY)
ok(fp is not None and len(fp) == 64, "氏名と生年月日が読めれば識別子を作れる")
ok(document_fingerprint(hanako, KEY) == fp, "同じ書類なら同じ識別子（撮り直しても同じ）")
ok(document_fingerprint(ichiro, KEY) != fp,
   "様式が同じでも別人なら別の識別子（以前の pHash はここで誤って一致していた）")
ok(document_fingerprint(["氏名 見本花子", "平成5年4月1日生"], KEY) == fp,
   "空白の入り方や全角・半角が違っても同じ人と分かる")
ok(document_fingerprint(["氏名　見本　花子 平成5年4月1日生"], KEY) == fp,
   "氏名と生年月日が同じ行に並ぶ券面でも読める")
ok(document_fingerprint(hanako, b"other-key") != fp, "鍵が違えば別の識別子（鍵なしでは照合できない）")
ok("花子" not in fp and "見本" not in fp, "識別子に氏名そのものは入らない")
ok(document_fingerprint(["運転免許証", "東京都公安委員会"], KEY) is None, "氏名が読めなければ作らない")
ok(document_fingerprint(["氏名　見本　花子"], KEY) is None, "生年月日が読めなければ作らない")

# --- 有効期限 ---------------------------------------------------------
ok(parse_expiry(["有効期限", "令和8年5月20日まで有効"]) == date(2026, 5, 20), "令和の日付を読める")
ok(parse_expiry(["有効期限 2030年3月1日"]) == date(2030, 3, 1), "西暦の日付を読める")
ok(parse_expiry(["氏名 山田太郎"]) is None, "日付が無ければ None")
ok(
    parse_expiry(["生年月日 平成2年1月1日", "有効期限", "令和9年1月1日"]) == date(2027, 1, 1),
    "生年月日ではなく有効期限を拾う",
)

# --- 顔・モアレ -------------------------------------------------------
ok(count_faces(image) == 0, "ノイズ画像に顔は検出されない")
ok(moire_score(np.full((400, 640, 3), 128, dtype=np.uint8)) >= 0, "モアレ計算が例外を投げない")

# --- 旗の判定 ---------------------------------------------------------
expired = inspect(
    "drivers_license", image, None,
    ["運転免許証", "公安委員会", "有効期限", "令和2年1月1日", "番号"],
    [0.9] * 5, fingerprint_key=KEY, today=date(2026, 9, 23),
)
ok("expired" in expired.flags, "期限切れに expired が立つ")
ok("keywords_missing" not in expired.flags, "券面の語があれば keywords_missing は立たない")
ok("fingerprint_unavailable" in expired.flags, "氏名が読めない券面では「使い回しを確かめられない」旗が立つ")

wrong = inspect("drivers_license", image, None, ["まったく関係ない文字列"], [0.9],
                fingerprint_key=KEY, today=date(2026, 9, 23))
ok("keywords_missing" in wrong.flags, "違う紙なら keywords_missing が立つ")
ok("unreadable" in wrong.flags, "文字数が少なければ unreadable が立つ")

print()
if failures:
    print(f"{failures} 件落ちました")
    sys.exit(1)
print("すべて通りました")

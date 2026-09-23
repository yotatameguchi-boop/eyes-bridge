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

from inspection import count_faces, inspect, moire_score, parse_expiry, perceptual_hash

failures = 0


def ok(condition: bool, label: str) -> None:
    global failures
    if not condition:
        failures += 1
    print(("PASS  " if condition else "FAIL  ") + label)


rng = np.random.default_rng(0)
image = rng.integers(0, 255, (400, 640, 3), dtype=np.uint8)

# --- 知覚ハッシュ -----------------------------------------------------
h1 = perceptual_hash(image)
ok(len(h1) == 64 and set(h1) <= {"0", "1"}, "pHash は 64bit の 0/1 文字列")
ok(perceptual_hash(image) == h1, "同じ画像なら同じハッシュ")

# 撮り直し相当（明るさが変わっても同じ書類と判定できること）
shifted = np.clip(image.astype(int) * 0.85 + 20, 0, 255).astype(np.uint8)
near = sum(a != b for a, b in zip(h1, perceptual_hash(shifted)))
ok(near <= 6, f"明るさが変わっても近い（ハミング距離 {near}）")

far = sum(a != b for a, b in zip(h1, perceptual_hash(rng.integers(0, 255, (400, 640, 3), dtype=np.uint8))))
ok(far > 6, f"別画像とは離れる（ハミング距離 {far}）")

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
    [0.9] * 5, today=date(2026, 9, 23),
)
ok("expired" in expired.flags, "期限切れに expired が立つ")
ok("keywords_missing" not in expired.flags, "券面の語があれば keywords_missing は立たない")
ok(expired.phash is not None, "pHash が返る")

wrong = inspect("drivers_license", image, None, ["まったく関係ない文字列"], [0.9], today=date(2026, 9, 23))
ok("keywords_missing" in wrong.flags, "違う紙なら keywords_missing が立つ")
ok("unreadable" in wrong.flags, "文字数が少なければ unreadable が立つ")

print()
if failures:
    print(f"{failures} 件落ちました")
    sys.exit(1)
print("すべて通りました")

"""日本語の見本画像を OCR と自動チェックに通す、実モデルを使う結合テスト。

mobile 系モデルに落としても日本語が読めること、有効期限を
生年月日・交付日と取り違えないことを確かめる。
実在の人物や番号は使わない（氏名は「見本 太郎」）。

日本語フォントが要る。イメージには入れていないので、
テストのときだけコンテナに持ち込む（macOS の例）:

    docker cp "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc" eyes-bridge-ocr-1:/tmp/jp.ttc
    docker compose exec -T ocr python - < ocr/test_japanese_sample.py
    docker compose exec -T ocr rm -f /tmp/jp.ttc
"""

import io
import json
import os
import sys
import urllib.request
import uuid

from PIL import Image, ImageDraw, ImageFont

FONT = "/tmp/jp.ttc"
TOKEN = os.environ.get("INSPECT_TOKEN", "local-dev-inspect-token")

if not os.path.exists(FONT):
    print(f"{FONT} がありません。ファイル冒頭の手順でフォントを持ち込んでください。")
    sys.exit(2)

large = ImageFont.truetype(FONT, 44)
medium = ImageFont.truetype(FONT, 30)


def card(expiry_line: str) -> bytes:
    img = Image.new("RGB", (1100, 700), (235, 240, 230))
    draw = ImageDraw.Draw(img)
    rows = [
        (large, "運転免許証"),
        (medium, "氏名　見本　太郎"),
        (medium, "生年月日　平成2年1月1日生"),
        (medium, "住所　東京都千代田区見本町1-1"),
        (medium, "交付　令和4年1月1日"),
        (medium, expiry_line),
        (medium, "免許の条件等"),
        (medium, "東京都公安委員会"),
    ]
    y = 40
    for font, text in rows:
        draw.text((60, y), text, font=font, fill=(20, 20, 20))
        y += 75
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def post(path: str, fields: dict, files: dict) -> dict:
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        )
    for key, data in files.items():
        parts += [
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{key}.jpg"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n".encode(),
            data,
            b"\r\n",
        ]
    parts.append(f"--{boundary}--\r\n".encode())
    request = urllib.request.Request(
        f"http://localhost:8080{path}",
        data=b"".join(parts),
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "x-inspect-token": TOKEN,
        },
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.load(response)


failures = 0


def ok(condition: bool, label: str) -> None:
    global failures
    if not condition:
        failures += 1
    print(("PASS  " if condition else "FAIL  ") + label)


valid = card("令和9年1月1日まで有効")

read = post("/ocr", {}, {"image": valid})
text = read["text"]
for expected in ["運転免許証", "生年月日", "東京都公安委員会", "令和9年1月1日"]:
    ok(expected in text, f"OCR が「{expected}」を読める")

checked = post("/inspect-document", {"kind": "drivers_license"}, {"front": valid})
ok(checked["details"]["expiry"] == "2027-01-01", "有効期限を生年月日・交付日と取り違えない")
ok("expired" not in checked["flags"], "有効な見本に expired は立たない")
ok("keywords_missing" not in checked["flags"], "券面の語を拾える")
ok("unreadable" not in checked["flags"], "読めている見本に unreadable は立たない")

expired = post("/inspect-document", {"kind": "drivers_license"}, {"front": card("令和5年1月1日まで有効")})
ok("expired" in expired["flags"], "期限切れの見本に expired が立つ")

print()
if failures:
    print(f"{failures} 件落ちました")
    sys.exit(1)
print("すべて通りました")

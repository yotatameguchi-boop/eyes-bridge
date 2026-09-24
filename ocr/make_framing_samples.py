"""撮影の案内のテスト用データ（app/src/lib/__fixtures__/framing_samples.json）を作り直す。

見本の券面（実在しない「見本 花子」。ocr/test_japanese_sample.py と同じ作り方）から
「撮り方の失敗」を作り、コンテナで動いている本物の /ocr に通した応答を記録する。
閾値を決めるときに思い込みで作ると外れる（最初の案は5か所外れた）ので、
必ず本物の検出結果から作ること。

    docker cp card.jpg eyes-bridge-ocr-1:/tmp/card.jpg
    docker compose exec -T ocr python - < ocr/make_framing_samples.py > samples.json
    docker compose exec -T ocr rm -f /tmp/card.jpg

出力に "_note" を足して app/src/lib/__fixtures__/framing_samples.json に置く。
"""

import io
import json
import os
import urllib.request
import uuid

from PIL import Image, ImageEnhance, ImageFilter

card = Image.open("/tmp/card.jpg").convert("RGB")  # 1100x700、文字は x=60〜約560
TABLE = (120, 110, 100)  # 机の色


def on_table(img: Image.Image, canvas=(1500, 1100), at=None) -> Image.Image:
    bg = Image.new("RGB", canvas, TABLE)
    x = (canvas[0] - img.width) // 2 if at is None else at[0]
    y = (canvas[1] - img.height) // 2 if at is None else at[1]
    bg.paste(img, (x, y))
    return bg


scenes = {
    "ok": on_table(card),
    # 画面の右端が文字の途中を通る（紙が右にはみ出している）
    "cut_right": on_table(card, canvas=(900, 1000), at=(500, 150)).crop((0, 0, 900, 1000)),
    # 画面の下端が文字の途中を通る。横に切れた行は検出されないので「切れた証拠」は残らない
    "cut_bottom": on_table(card, canvas=(1500, 1100), at=(200, 600)),
    "too_close": card.crop((200, 120, 800, 560)).resize((1200, 880)),
    "too_far": on_table(card.resize((330, 210)), canvas=(1600, 1200)),
    "blurry": on_table(card).filter(ImageFilter.GaussianBlur(9)),
    "dark": ImageEnhance.Brightness(on_table(card)).enhance(0.12),
    "blank": Image.new("RGB", (1500, 1100), (236, 233, 226)),
}
# 右がはみ出した写真を、スマホを横に倒して撮った場合（反時計回り90度）。
# スマホから見ると、はみ出しているのは上側になる
scenes["cut_right_sideways"] = scenes["cut_right"].rotate(90, expand=True)


def ocr(img: Image.Image) -> dict:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    boundary = uuid.uuid4().hex
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="x.jpg"\r\n'
        f"Content-Type: image/jpeg\r\n\r\n".encode(),
        buf.getvalue(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    request = urllib.request.Request(
        "http://localhost:8080/ocr",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "x-ocr-token": os.environ.get("OCR_TOKEN", "local-dev-ocr-token"),
        },
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


print(json.dumps({name: ocr(img) for name, img in scenes.items()}, ensure_ascii=False, indent=1))

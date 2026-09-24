"""テストに使う見本画像を作る（E2E・デモデータ・撮影の案内の fixture 用）。

実在の書類の画像は使わない。フォントで描いた「見本 花子」の券面と、
顔の写っていない自撮りの代わり（ノイズ）を作る。

日本語フォントはイメージに入れていないので、作るときだけ持ち込む（macOS の例）:

    docker cp "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc" eyes-bridge-ocr-1:/tmp/jp.ttc
    docker compose exec -T ocr python - < ocr/make_sample_images.py
    docker cp eyes-bridge-ocr-1:/tmp/card.jpg ./card.jpg
    docker cp eyes-bridge-ocr-1:/tmp/selfie.jpg ./selfie.jpg
    docker compose exec -T ocr rm -f /tmp/jp.ttc /tmp/card.jpg /tmp/selfie.jpg
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont

large = ImageFont.truetype("/tmp/jp.ttc", 44)
medium = ImageFont.truetype("/tmp/jp.ttc", 30)

card = Image.new("RGB", (1100, 700), (235, 240, 230))
draw = ImageDraw.Draw(card)
rows = [
    (large, "運転免許証"),
    (medium, "氏名　見本　花子"),
    (medium, "生年月日　平成5年4月1日生"),
    (medium, "住所　東京都千代田区見本町2-2"),
    (medium, "交付　令和5年4月1日"),
    (medium, "令和10年5月1日まで有効"),
    (medium, "免許の条件等"),
    (medium, "東京都公安委員会"),
]
y = 40
for font, text in rows:
    draw.text((60, y), text, font=font, fill=(20, 20, 20))
    y += 75
card.save("/tmp/card.jpg", quality=92)

rng = np.random.default_rng(3)
Image.fromarray(rng.integers(0, 255, (480, 480, 3), dtype=np.uint8)).save("/tmp/selfie.jpg", quality=90)

print("/tmp/card.jpg と /tmp/selfie.jpg を作りました")

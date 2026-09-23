"""写り方の材料（framing.py）のテスト。モデル不要。

    docker compose exec -T ocr python - < ocr/test_framing.py
"""

import sys

import numpy as np
from PIL import Image, ImageFilter

from framing import frame_quality, to_capture_frame

failures = 0


def ok(condition: bool, label: str) -> None:
    global failures
    if not condition:
        failures += 1
    print(("PASS  " if condition else "FAIL  ") + label)


# --- 向きの戻し方 -----------------------------------------------------
# 文書の左上にある枠が、撮ったときにどこにあったか。
# 実際の PaddleOCR の挙動（反時計回り90度に撮った写真は angle=270）で確かめた向き。
top_left = (0.05, 0.05, 0.15, 0.10)
ok(to_capture_frame(top_left, 0) == [0.05, 0.05, 0.15, 0.10], "回していなければそのまま")

# 反時計回りに90度倒して撮ると、文書の左上はスマホから見て左下に来る
x0, y0, x1, y1 = to_capture_frame(top_left, 270)
ok(x0 < 0.2 and y1 > 0.8, f"angle=270 なら文書の左上は撮影時の左下（{[x0, y0, x1, y1]}）")

# 上下逆さに撮ると、文書の左上はスマホから見て右下に来る
x0, y0, x1, y1 = to_capture_frame(top_left, 180)
ok(x1 > 0.8 and y1 > 0.8, f"angle=180 なら文書の左上は撮影時の右下（{[x0, y0, x1, y1]}）")

# 時計回りに90度倒して撮った場合（angle=90）は右上
x0, y0, x1, y1 = to_capture_frame(top_left, 90)
ok(x1 > 0.8 and y0 < 0.2, f"angle=90 なら文書の左上は撮影時の右上（{[x0, y0, x1, y1]}）")

# 文書の右端に接する行は、横に倒して撮ると上端に接する（実データの cut_right_sideways と同じ）
right_edge = (0.5, 0.4, 0.995, 0.45)
_, y0, _, _ = to_capture_frame(right_edge, 270)
ok(y0 < 0.02, "文書の右端は、反時計回りに倒して撮ると撮影時の上端になる")

# --- 写り方の数値 -----------------------------------------------------
rng = np.random.default_rng(1)
sharp = rng.integers(0, 255, (600, 800, 3), dtype=np.uint8)
blurred = np.array(Image.fromarray(sharp).filter(ImageFilter.GaussianBlur(8)))
blank = np.full((600, 800, 3), 235, dtype=np.uint8)
dark = (sharp * 0.1).astype(np.uint8)

ok(frame_quality(blurred)["blur"] < frame_quality(sharp)["blur"] / 10, "ぼかすと blur が大きく下がる")
ok(frame_quality(blank)["contrast"] < 1, "白紙は濃淡のばらつきがほぼ 0")
ok(frame_quality(dark)["brightness"] < 30, "暗い写真は brightness が低い")

# 解像度の違うスマホで同じものを撮っても、blur の値が大きく変わらない
# （長辺を揃えて測っているため）。画素ごとの乱数では拡大縮小そのものが
# ぼかしになって比べられないので、線や文字のような構造のある絵で確かめる。
from PIL import ImageDraw
scene = Image.new("RGB", (3000, 2250), (230, 228, 220))
draw = ImageDraw.Draw(scene)
for i in range(40):
    y = 120 + i * 50
    draw.rectangle((200, y, 200 + (i * 97) % 2400 + 300, y + 18), fill=(30, 30, 30))
hi = np.array(scene)                                   # 高解像度のスマホ
lo = np.array(scene.resize((1500, 1125), Image.LANCZOS))  # 半分の解像度のスマホ
a, b = frame_quality(hi)["blur"], frame_quality(lo)["blur"]
ok(0.5 < b / a < 2, f"解像度が違っても blur はほぼ同じ（{a} と {b}）")

print()
if failures:
    print(f"{failures} 件落ちました")
    sys.exit(1)
print("すべて通りました")

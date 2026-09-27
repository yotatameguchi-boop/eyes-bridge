"""入口の歯止め（鍵・大きさ・画素数）のテスト。

PaddleOCR のモデルは要らない（写真を読む前に止まるものだけを扱う）。
コンテナに向けて流す（イメージに焼く必要はない）:

    docker compose exec -T ocr python - < ocr/test_limits.py
"""

import io
import os
import sys

os.environ.setdefault("OCR_TOKEN", "test-token")
sys.path.insert(0, "/srv")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

import main  # noqa: E402

main.OCR_TOKEN = "test-token"
client = TestClient(main.app)
failures = 0


def check(cond: bool, label: str) -> None:
    global failures
    print(("PASS  " if cond else "FAIL  ") + label)
    if not cond:
        failures += 1


def png(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("L", (width, height), 255).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def status_of(fn) -> int:
    try:
        fn()
    except HTTPException as exc:
        return exc.status_code
    return 200


# --- 鍵 ---
small = png(64, 64)
r = client.post("/ocr", files={"image": ("a.png", small, "image/png")})
check(r.status_code == 403, "鍵が無ければ読まない")
r = client.post("/ocr", files={"image": ("a.png", small, "image/png")}, headers={"x-ocr-token": "test-tokeN"})
check(r.status_code == 403, "1文字違う鍵では読まない")
check(status_of(lambda: main.require_token("test-token")) == 200, "正しい鍵なら通す")

# --- 大きさ ---
big = b"\0" * (main.MAX_BYTES + 1)
r = client.post("/ocr", files={"image": ("a.jpg", big, "image/jpeg")}, headers={"x-ocr-token": "test-token"})
check(r.status_code == 413, "12MB を超える写真は読まない")

# --- 画素数（展開すると巨大になる画像）---
bomb = png(10_000, 6_000)  # 6000万画素。PNG なら数十KB
check(len(bomb) < 1024 * 1024, f"試す画像そのものは小さい（{len(bomb) // 1024}KB）")
check(status_of(lambda: main.load_image(bomb)) == 413, "画素数が上限を超える画像は、展開する前に止める")
r = client.post("/ocr", files={"image": ("a.png", bomb, "image/png")}, headers={"x-ocr-token": "test-token"})
check(r.status_code == 413, "/ocr でも同じく 413 を返す")

huge = png(30_000, 30_000)  # Pillow 自身の上限（倍）も超える
check(status_of(lambda: main.load_image(huge)) == 413, "Pillow が例外を出す大きさでも 413 で返す（500 にしない）")

ok = png(4_000, 3_000)
check(main.load_image(ok).shape[:2] == (1500, 2000), "普通の写真の大きさは読み、長辺 2000 に縮める")

check(status_of(lambda: main.load_image(b"not an image")) == 400, "画像でないものは 400")

# --- 手元用の鍵のまま本番で動かさない ---
import subprocess  # noqa: E402


def starts(env: dict) -> bool:
    base = {k: v for k, v in os.environ.items() if k not in ("OCR_TOKEN", "FINGERPRINT_KEY", "ALLOW_DEV_SECRETS")}
    return subprocess.run([sys.executable, "-c", "import main"], cwd="/srv", env={**base, **env},
                          capture_output=True).returncode == 0


check(not starts({"OCR_TOKEN": "local-dev-ocr-token", "FINGERPRINT_KEY": "x" * 40}),
      "OCR_TOKEN が手元用の値のままだと起動しない")
check(not starts({"OCR_TOKEN": "y" * 40, "FINGERPRINT_KEY": "local-dev-fingerprint-key"}),
      "FINGERPRINT_KEY が手元用の値のままだと起動しない")
check(starts({"OCR_TOKEN": "local-dev-ocr-token", "FINGERPRINT_KEY": "local-dev-fingerprint-key",
              "ALLOW_DEV_SECRETS": "true"}), "手元だけは明示して許せる")
check(starts({"OCR_TOKEN": "y" * 40, "FINGERPRINT_KEY": "x" * 40}), "本番の値なら起動する")

sys.exit(1 if failures else 0)

"""撮れた写真の「写り方」を数字にする。撮影の案内（どちらにずらすか等）の材料。

判断そのもの（何と声をかけるか）はアプリ側の framing.ts がやる。
ここは材料を出すだけにしてある。将来、撮る前に案内するライブ方式に
したとき、端末内の文字検出の結果を同じ判断にそのまま渡せるように。
"""

from __future__ import annotations

import cv2
import numpy as np

# ぼけ具合は解像度で値が変わるので、長辺をこの大きさに揃えてから測る
_BLUR_EDGE = 1000


def frame_quality(image: np.ndarray) -> dict:
    """ぼけ（ラプラシアンの分散。小さいほどぼけている）・明るさ（0〜255）・濃淡のばらつき。"""
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    scale = _BLUR_EDGE / max(gray.shape)
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    return {
        "blur": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1),
        "brightness": round(float(gray.mean()), 1),
        # 濃淡のばらつき。ひどくぼけた写真では文字が1行も検出されず、
        # 白紙の写真と見分けがつかない（どちらもぼけの値がほぼ 0）。
        # ぼけていても紙と机の境目などの濃淡は残るので、これで分ける。
        "contrast": round(float(gray.std()), 1),
    }


def _rotate_cw(u: float, v: float) -> tuple[float, float]:
    """正規化座標 (u, v) を時計回りに90度回したときの位置。"""
    return 1.0 - v, u


def to_capture_frame(box: tuple[float, float, float, float], angle: int) -> list[float]:
    """文書の向きに起こした座標を、撮ったときの向きの座標に戻す。

    PaddleOCR は横向きに撮られた写真を起こしてから読み、座標も起こした後の
    向きで返す（90度反時計回りに撮った写真は angle=270 になり、座標は
    まっすぐ撮った場合と同じになる。実際に確かめた）。一方「右へずらして」の
    「右」は、利用者がスマホを構えている向きでの右でなければならない。
    起こした画像 = 撮った画像を反時計回りに angle 度回したもの、なので、
    時計回りに angle 度回せば元の向きに戻る。
    """
    x0, y0, x1, y1 = box
    corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    for _ in range((angle // 90) % 4):
        corners = [_rotate_cw(u, v) for u, v in corners]
    us = [u for u, _ in corners]
    vs = [v for _, v in corners]
    return [round(min(us), 4), round(min(vs), 4), round(max(us), 4), round(max(vs), 4)]

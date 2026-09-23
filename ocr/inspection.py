"""本人確認書類の自動チェック。

ここで出すのは「判定」ではなく「人が見るための材料」。
書類の真贋を機械が断定できる前提で作ると、見逃したときに
誰も気づかない仕組みになる。最終的に承認するのは人。

やっていること:
  * OCR で、その書類にあるはずの語が写っているかを見る
  * 有効期限を読み、切れていないかを見る
  * 顔が写っているかを数える（本人と一致するかは見ない）
  * 知覚ハッシュを出す（同じ書類の使い回しを後から検出するため）
  * 画面を撮り直した疑いを、モアレの強さから弱いシグナルとして出す

やっていないこと:
  * 書類の顔写真と自撮りが同一人物かの照合
    生体データの保存を伴うため、入れるなら同意と取り扱いを別途設計する
  * ホログラム・透かし・券面の材質の検証
    平面の写真からは原理的に見えない
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

import cv2
import numpy as np

# 券面に必ず出る語。1つも無ければ、そもそも違う紙を撮っている。
EXPECTED_KEYWORDS: dict[str, list[str]] = {
    "drivers_license": ["運転免許証", "公安委員会", "有効期限", "免許の条件"],
    "my_number_card": ["個人番号カード", "マイナンバー", "氏名", "生年月日", "有効期限"],
    "passport": ["旅券", "PASSPORT", "JAPAN", "日本国"],
    "residence_card": ["在留カード", "RESIDENCE", "在留資格", "就労"],
}

# 元号の開始年。令和1年 = 2019年。
ERA_BASE = {"令和": 2018, "平成": 1988, "昭和": 1925}

_ERA_DATE = re.compile(r"(令和|平成|昭和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
_WESTERN_DATE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")


@dataclass
class Inspection:
    flags: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)
    phash: str | None = None

    def flag(self, name: str) -> None:
        if name not in self.flags:
            self.flags.append(name)


def perceptual_hash(image: np.ndarray) -> str:
    """DCT ベースの pHash を 64bit の文字列で返す。

    撮り直し・圧縮・軽いトリミングでも近い値になるので、
    ハミング距離で「同じ書類か」を見られる。
    元画像は復元できないので、画像を消したあとも残せる。
    """
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)

    dct = cv2.dct(small)
    # 低周波の 8x8 だけ使う。左上(直流成分)は明るさそのものなので中央値から外す。
    block = dct[:8, :8]
    median = np.median(np.delete(block.flatten(), 0))

    bits = (block.flatten() > median).astype(np.uint8)
    return "".join(str(b) for b in bits)


def count_faces(image: np.ndarray) -> int:
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    gray = cv2.equalizeHist(gray)

    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    return len(faces)


def moire_score(image: np.ndarray) -> float:
    """画面を撮り直したときに出る周期的な縞の強さ。

    液晶の画素格子がモアレとして残ると、周波数領域に中心から離れた
    鋭いピークが立つ。紙を直接撮った画像には普通は出ない。

    ただしこれは弱いシグナルで、布や網戸ごしでも上がるし、
    高解像度の画面を離れて撮れば出ない。単独で却下の理由にはしない。
    """
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    gray = cv2.resize(gray, (512, 512), interpolation=cv2.INTER_AREA).astype(np.float32)

    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray * np.hanning(512)[:, None] * np.hanning(512))))

    center = 256
    y, x = np.ogrid[:512, :512]
    radius = np.sqrt((y - center) ** 2 + (x - center) ** 2)

    # 中心付近（=画像そのものの構造）を除いた外側を見る
    outer = spectrum[(radius > 60) & (radius < 240)]
    if outer.size == 0:
        return 0.0

    return float(np.percentile(outer, 99.9) / (np.median(outer) + 1e-6))


def parse_expiry(texts: list[str]) -> date | None:
    """券面から有効期限を拾う。

    「有効期限」の語の近くにある日付を優先する。
    生年月日や交付日を期限と読み違えると、期限切れを見逃す。
    """
    joined = [t for t in texts if t.strip()]

    near_label: list[str] = []
    for i, text in enumerate(joined):
        if "有効期限" in text or "有効期間" in text:
            near_label.extend(joined[i : i + 3])

    for pool in (near_label, joined):
        found = [d for d in (_to_date(t) for t in pool) if d is not None]
        if found:
            # 期限は書類上いちばん未来の日付になることが多い
            return max(found)

    return None


def _to_date(text: str) -> date | None:
    era = _ERA_DATE.search(text)
    if era:
        name, year, month, day = era.group(1), int(era.group(2)), int(era.group(3)), int(era.group(4))
        try:
            return date(ERA_BASE[name] + year, month, day)
        except ValueError:
            return None

    western = _WESTERN_DATE.search(text)
    if western:
        try:
            return date(int(western.group(1)), int(western.group(2)), int(western.group(3)))
        except ValueError:
            return None

    return None


def inspect(
    kind: str,
    front: np.ndarray,
    selfie: np.ndarray | None,
    texts: list[str],
    confidences: list[float],
    today: date | None = None,
) -> Inspection:
    today = today or date.today()
    result = Inspection()

    # --- 券面の語 ---
    expected = EXPECTED_KEYWORDS.get(kind, [])
    blob = "".join(texts).upper()
    matched = [k for k in expected if k.upper() in blob]
    result.details["matched_keywords"] = matched

    if expected and not matched:
        result.flag("keywords_missing")

    # --- 読めているか ---
    mean_confidence = float(np.mean(confidences)) if confidences else 0.0
    result.details["ocr_confidence"] = round(mean_confidence, 3)
    if mean_confidence < 0.6 or len(texts) < 4:
        # 読めない写真は審査できない。偽造以前に撮り直してもらう。
        result.flag("unreadable")

    # --- 有効期限 ---
    expiry = parse_expiry(texts)
    result.details["expiry"] = expiry.isoformat() if expiry else None
    if expiry is None:
        result.flag("expiry_not_found")
    elif expiry < today:
        result.flag("expired")

    # --- 顔 ---
    front_faces = count_faces(front)
    result.details["faces_in_document"] = front_faces
    if front_faces == 0:
        result.flag("no_face_in_document")

    if selfie is not None:
        selfie_faces = count_faces(selfie)
        result.details["faces_in_selfie"] = selfie_faces
        if selfie_faces == 0:
            result.flag("no_face_in_selfie")
        elif selfie_faces > 1:
            result.flag("multiple_faces_in_selfie")

    # 同一人物かどうかは見ていない。人が見る前提。
    result.details["face_match_checked"] = False

    # --- 画面の撮り直し疑い ---
    score = moire_score(front)
    result.details["moire_score"] = round(score, 1)
    if score > 40:
        result.flag("possible_screen_capture")

    # --- 使い回しの検出用 ---
    result.phash = perceptual_hash(front)

    return result

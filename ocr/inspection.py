"""本人確認書類の自動チェック。

ここで出すのは「判定」ではなく「人が見るための材料」。
書類の真贋を機械が断定できる前提で作ると、見逃したときに
誰も気づかない仕組みになる。最終的に承認するのは人。

やっていること:
  * OCR で、その書類にあるはずの語が写っているかを見る
  * 有効期限を読み、切れていないかを見る
  * 顔が写っているかを数える（本人と一致するかは見ない）
  * 氏名と生年月日から、元に戻せない識別子を作る（同じ書類の使い回しを検出するため）
  * 画面を撮り直した疑いを、モアレの強さから弱いシグナルとして出す

やっていないこと:
  * 書類の顔写真と自撮りが同一人物かの照合
    生体データの保存を伴うため、入れるなら同意と取り扱いを別途設計する
  * ホログラム・透かし・券面の材質の検証
    平面の写真からは原理的に見えない
"""

from __future__ import annotations

import hashlib
import hmac
import re
import unicodedata
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
    fingerprint: str | None = None

    def flag(self, name: str) -> None:
        if name not in self.flags:
            self.flags.append(name)


def _normalize(text: str) -> str:
    """全角・半角と空白の違いで別人扱いにならないよう揃える。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _extract_name_and_birth(texts: list[str]) -> tuple[str, date] | None:
    """券面から氏名と生年月日を拾う。どちらかが読めなければ None。

    運転免許証・マイナンバーカードの表面は「氏名」の欄がある。
    生年月日は「生年月日」の欄か、「〜日生」と書かれた日付。
    氏名と生年月日が同じ行に並ぶ券面もあるので、氏名からは日付を取り除く。
    """
    name = ""
    for text in texts:
        if "氏名" in text:
            rest = text.split("氏名", 1)[1]
            rest = re.split(r"(令和|平成|昭和|\d{4}\s*年)", rest)[0]
            name = _normalize(rest)
            if name:
                break

    birth = None
    for text in texts:
        if "生年月日" in text or re.search(r"日\s*生", text):
            birth = _to_date(text)
            if birth:
                break

    if not name or birth is None:
        return None
    return name, birth


def document_fingerprint(texts: list[str], key: bytes) -> str | None:
    """同じ人の書類かどうかを比べるための、元に戻せない識別子。

    以前は画像の知覚ハッシュ（pHash）を使っていたが、様式が同じ書類は
    別人どうしでもハミング距離が 2〜6 になり（実際に確かめた）、
    使い回しの判定（6以下）に引っかかった。pHash が捉えるのは
    「見た目の様式」で、「誰の書類か」ではないため。

    ここでは氏名と生年月日から、サーバだけが持つ鍵で HMAC を取る。
    鍵が無ければ、氏名と生年月日の組み合わせを総当たりしても戻せない。
    氏名と生年月日そのものは返さない・残さない。
    """
    found = _extract_name_and_birth(texts)
    if found is None:
        return None
    name, birth = found
    message = f"{name}|{birth.isoformat()}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()


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
    fingerprint_key: bytes,
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
    result.fingerprint = document_fingerprint(texts, fingerprint_key)
    result.details["fingerprint"] = result.fingerprint is not None
    if result.fingerprint is None:
        # 氏名か生年月日が読めず、使い回しを確かめられなかった。
        # 黙って「使い回しなし」に見せない
        result.flag("fingerprint_unavailable")

    return result

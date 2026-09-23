"""写真から文字を取り出して返すだけのサーバ。

方針:
  * 画像は保存しない。処理して捨てる。
    薬袋・請求書・診断書が飛んでくる前提なので、置いた瞬間に漏洩面になる。
  * 読み順を推定して返す。左上から右下に素直に並べると、
    レシートや帳票で金額と品名がばらばらになって読み上げが成立しない。
  * 信頼度をそのまま返す。低い行をアプリ側が「自信が無い」と伝えられるように。
"""

from __future__ import annotations

import io
import logging
import os
from dataclasses import dataclass

import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps
from pydantic import BaseModel

from inspection import Inspection, inspect as inspect_document

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ocr")

MAX_BYTES = 12 * 1024 * 1024
MAX_EDGE = 2000  # これ以上大きくしても精度は上がらず、CPU時間だけ伸びる

app = FastAPI(title="eyes-bridge OCR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["POST"],
    allow_headers=["*"],
)


class Block(BaseModel):
    text: str
    confidence: float


class OcrResponse(BaseModel):
    text: str
    blocks: list[Block]
    engine: str


class InspectResponse(BaseModel):
    flags: list[str]
    details: dict
    phash: str | None


@dataclass
class Line:
    text: str
    confidence: float
    x: float
    y: float
    height: float


_engine = None


def engine():
    """PaddleOCR は初期化にモデルのダウンロードを伴うので遅延生成する。"""
    global _engine
    if _engine is None:
        from paddleocr import PaddleOCR

        _engine = PaddleOCR(
            lang="japan",
            use_doc_orientation_classify=True,  # 横に倒して撮られた写真を起こす
            use_doc_unwarping=False,            # 手持ち撮影では歪み補正が裏目に出やすい
            use_textline_orientation=True,      # 縦書き対応
        )
        log.info("PaddleOCR ready")
    return _engine


def load_image(raw: bytes) -> np.ndarray:
    try:
        image = Image.open(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="UNREADABLE_IMAGE") from exc

    # スマホ写真は EXIF に回転が入っている。無視すると横倒しのまま認識して精度が落ちる
    image = ImageOps.exif_transpose(image).convert("RGB")

    if max(image.size) > MAX_EDGE:
        scale = MAX_EDGE / max(image.size)
        image = image.resize((int(image.width * scale), int(image.height * scale)))

    return np.array(image)


def sort_for_reading(lines: list[Line]) -> list[Line]:
    """行を人が読む順に並べ替える。

    y だけで並べると、同じ行にある品名と金額が分断される。
    文字高の半分を許容幅として「同じ行」をまとめ、その中で x 順に読む。
    """
    if not lines:
        return []

    tolerance = max(np.median([l.height for l in lines]) * 0.5, 8.0)
    ordered = sorted(lines, key=lambda l: l.y)

    rows: list[list[Line]] = [[ordered[0]]]
    for line in ordered[1:]:
        if abs(line.y - rows[-1][0].y) <= tolerance:
            rows[-1].append(line)
        else:
            rows.append([line])

    return [line for row in rows for line in sorted(row, key=lambda l: l.x)]


def extract(image: np.ndarray) -> list[Line]:
    result = engine().predict(image)
    lines: list[Line] = []

    for page in result:
        texts = page.get("rec_texts", [])
        scores = page.get("rec_scores", [])
        boxes = page.get("rec_polys", page.get("dt_polys", []))

        for text, score, box in zip(texts, scores, boxes):
            if not text.strip():
                continue
            points = np.array(box, dtype=float).reshape(-1, 2)
            lines.append(
                Line(
                    text=text,
                    confidence=float(score),
                    x=float(points[:, 0].min()),
                    y=float(points[:, 1].min()),
                    height=float(points[:, 1].max() - points[:, 1].min()),
                )
            )

    return lines


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ocr", response_model=OcrResponse)
async def ocr(image: UploadFile = File(...)) -> OcrResponse:
    raw = await image.read()
    if len(raw) == 0:
        raise HTTPException(status_code=400, detail="EMPTY_IMAGE")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="IMAGE_TOO_LARGE")

    lines = sort_for_reading(extract(load_image(raw)))

    # raw はここで参照を落とす。ディスクにもログにも残さない。
    del raw

    return OcrResponse(
        text="\n".join(l.text for l in lines),
        blocks=[Block(text=l.text, confidence=round(l.confidence, 3)) for l in lines],
        engine="paddleocr-japan",
    )


# --------------------------------------------------------------- 本人確認
# 書類の自動チェック。人が審査するための材料を出すだけで、
# ここで承認・却下は決めない。
#
# 呼べるのは inspect-identity（Edge Function）だけ。
# 本人確認書類が飛んでくる口を、誰でも叩ける状態にしない。
INSPECT_TOKEN = os.environ.get("INSPECT_TOKEN")


@app.post("/inspect-document", response_model=InspectResponse)
async def inspect_endpoint(
    kind: str = Form(...),
    front: UploadFile = File(...),
    selfie: UploadFile | None = File(None),
    x_inspect_token: str | None = Header(None),
) -> InspectResponse:
    # 未設定なら開けない。設定し忘れを「誰でも通る」で吸収しない。
    if not INSPECT_TOKEN:
        raise HTTPException(status_code=503, detail="INSPECT_NOT_CONFIGURED")
    if x_inspect_token != INSPECT_TOKEN:
        raise HTTPException(status_code=403, detail="BAD_INSPECT_TOKEN")

    front_raw = await front.read()
    if not front_raw:
        raise HTTPException(status_code=400, detail="EMPTY_IMAGE")
    if len(front_raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="IMAGE_TOO_LARGE")

    front_image = load_image(front_raw)

    selfie_image = None
    if selfie is not None:
        selfie_raw = await selfie.read()
        if selfie_raw:
            if len(selfie_raw) > MAX_BYTES:
                raise HTTPException(status_code=413, detail="IMAGE_TOO_LARGE")
            selfie_image = load_image(selfie_raw)
        del selfie_raw

    lines = extract(front_image)

    result: Inspection = inspect_document(
        kind=kind,
        front=front_image,
        selfie=selfie_image,
        texts=[line.text for line in lines],
        confidences=[line.confidence for line in lines],
    )

    # 券面に書かれている内容は返さない。
    # 氏名も住所も、こちらで持つ理由が無い。
    del front_raw, front_image, selfie_image, lines

    return InspectResponse(flags=result.flags, details=result.details, phash=result.phash)

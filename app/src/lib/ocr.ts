import { OCR_URL } from "./env";
import type { FrameInfo, FrameLine } from "./framing";

/** 1行分。box は撮ったときの向きでの位置（0〜1 に正規化した x0, y0, x1, y1） */
export type OcrBlock = FrameLine;

export type OcrResult = {
  text: string;
  blocks: OcrBlock[];
  /** 写り方。撮影の案内の材料（判断は framing.ts） */
  frame: FrameInfo & { rotated: number };
  engine: string;
};

export const ocrAvailable = OCR_URL !== null;

/**
 * 撮った写真をサーバに渡して文字を取り出す。
 *
 * 端末内 OCR にしなかった理由:
 *   日本語の縦書き・手書き・レシートは軽量モデルだと実用精度に届かない。
 *   「読めたが間違っている」は、読めないことより危ない（薬の用量、金額）。
 *   精度の出るモデルをサーバに置き、信頼度が低い行はその旨を読み上げる。
 */
export async function readImage(imageUri: string): Promise<OcrResult> {
  if (!OCR_URL) throw new Error("OCR_NOT_CONFIGURED");

  const form = new FormData();
  form.append("image", {
    uri: imageUri,
    name: "capture.jpg",
    type: "image/jpeg",
  } as unknown as Blob);

  const res = await fetch(`${OCR_URL}/ocr`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`OCR_FAILED_${res.status}`);

  return (await res.json()) as OcrResult;
}

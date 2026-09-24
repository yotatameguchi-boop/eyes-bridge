import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";
import { supabase } from "./supabase";
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

/** 読めなかった理由。画面はこれを見て言うことを変える。 */
export type OcrErrorCode =
  | "RATE_LIMITED"
  | "BLOCKED"
  | "NOT_SIGNED_IN"
  | "NOT_CONFIGURED"
  | "BAD_IMAGE"
  | "FAILED";

export class OcrError extends Error {
  constructor(readonly code: OcrErrorCode) {
    super(code);
  }
}

function ocrErrorCode(status: number): OcrErrorCode {
  switch (status) {
    case 429:
      return "RATE_LIMITED";
    case 403:
      return "BLOCKED";
    case 401:
      return "NOT_SIGNED_IN";
    case 503:
      return "NOT_CONFIGURED";
    case 400:
    case 413:
      return "BAD_IMAGE";
    default:
      return "FAILED";
  }
}

/**
 * 撮った写真をサーバに渡して文字を取り出す。
 *
 * 端末内 OCR にしなかった理由:
 *   日本語の縦書き・手書き・レシートは軽量モデルだと実用精度に届かない。
 *   「読めたが間違っている」は、読めないことより危ない（薬の用量、金額）。
 *   精度の出るモデルをサーバに置き、信頼度が低い行はその旨を読み上げる。
 */
export async function readImage(imageUri: string): Promise<OcrResult> {
  // OCR サーバは直接呼ばない（外に公開しない）。Edge Function（read-image）が
  // ログインと回数の上限を確かめてから、共有の鍵を付けて渡す。
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new OcrError("NOT_SIGNED_IN");

  const form = new FormData();
  form.append("image", {
    uri: imageUri,
    name: "capture.jpg",
    type: "image/jpeg",
  } as unknown as Blob);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/read-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    body: form,
  });
  if (!res.ok) throw new OcrError(ocrErrorCode(res.status));

  return (await res.json()) as OcrResult;
}

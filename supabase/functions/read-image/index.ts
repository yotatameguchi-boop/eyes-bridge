// 写真の文字を読む。アプリはここを通して OCR サーバを使う。
//
// 以前はアプリが OCR サーバを直接呼んでおり、OCR サーバには鍵が無かった。
// URL が分かれば誰でも無料の読み取りとして使え、サーバ代がかさむ。
// ここで「ログインしているか」「回数の上限を超えていないか」を確かめてから、
// 共有の鍵を付けて OCR サーバに渡す。OCR サーバ自体は外に公開しない。
//
// 写真は読まずにそのまま流す。Edge Function には CPU 時間 2秒 / メモリ 256MB の
// 上限があり、数MBの写真をここで解釈する意味は無い（中身は OCR サーバが確かめる）。
import { authenticate, CORS, HttpError, serveJson } from "../_shared/auth.ts";

const MAX_BYTES = 12 * 1024 * 1024; // OCR サーバ側の上限と揃える

Deno.serve(serveJson(async (req) => {
  const { db } = await authenticate(req);

  const ocrUrl = Deno.env.get("OCR_URL");
  const ocrToken = Deno.env.get("OCR_TOKEN");
  if (!ocrUrl || !ocrToken) throw new HttpError(503, "OCR_NOT_CONFIGURED");

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(400, "EXPECTED_MULTIPART");
  }
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) throw new HttpError(413, "IMAGE_TOO_LARGE");

  // 回数の上限。止まっている人・未ログインもここで弾かれる
  const { error: quotaError } = await db.rpc("consume_ocr_quota");
  if (quotaError) {
    const message = quotaError.message;
    if (message.includes("RATE_LIMITED")) throw new HttpError(429, "RATE_LIMITED");
    if (message.includes("USER_BLOCKED")) throw new HttpError(403, "USER_BLOCKED");
    if (message.includes("NOT_SIGNED_IN")) throw new HttpError(401, "NOT_SIGNED_IN");
    throw new HttpError(500, message);
  }

  const response = await fetch(`${ocrUrl}/ocr`, {
    method: "POST",
    headers: { "content-type": contentType, "x-ocr-token": ocrToken },
    body: req.body,
    // 受け取った本文をそのまま流す
    // @ts-ignore: Deno の fetch は duplex を受け付けるが、型定義に無い版がある
    duplex: "half",
  });

  if (!response.ok) {
    console.error("ocr failed", response.status, await response.text());
    // 写真が壊れている・大きすぎるなど、利用者側で直せるものはそのまま返す
    if (response.status === 400 || response.status === 413) {
      throw new HttpError(response.status, "BAD_IMAGE");
    }
    throw new HttpError(502, "OCR_FAILED");
  }

  return new Response(response.body, {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}));

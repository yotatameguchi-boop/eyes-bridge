// 提出された本人確認書類を自動チェックにかける。
//
// 画像はクライアントから OCR サーバへ直接は渡さない。
// Storage から service role で取り出してこちらが渡す。
// クライアント経由にすると、審査に出したのと別の画像を
// 検査させることができてしまう。
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, HttpError, json, serveJson } from "../_shared/auth.ts";

const BUCKET = "identity-documents";

Deno.serve(serveJson(async (req) => {
  const { userId, db } = await authenticate(req);

  const { verificationId } = await req.json().catch(() => ({}));
  if (typeof verificationId !== "string") {
    throw new HttpError(400, "MISSING_VERIFICATION_ID");
  }

  const ocrUrl = Deno.env.get("OCR_URL");
  const ocrToken = Deno.env.get("OCR_TOKEN");
  if (!ocrUrl || !ocrToken) throw new HttpError(503, "INSPECT_NOT_CONFIGURED");

  // RLS 越しに読む。本人か運営でなければ行が返らない。
  const { data: verification, error } = await db
    .from("identity_verifications")
    .select("id, user_id, kind, front_path, selfie_path, state")
    .eq("id", verificationId)
    .single();

  if (error || !verification) throw new HttpError(404, "VERIFICATION_NOT_FOUND");

  const { data: profile } = await db
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();

  // 本人は自分の提出を、運営は全部を検査にかけられる。
  if (verification.user_id !== userId && !profile?.is_admin) {
    throw new HttpError(403, "NOT_ALLOWED");
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const [front, selfie] = await Promise.all([
    admin.storage.from(BUCKET).download(verification.front_path),
    admin.storage.from(BUCKET).download(verification.selfie_path),
  ]);

  if (front.error || !front.data) throw new HttpError(404, "FRONT_IMAGE_MISSING");

  const form = new FormData();
  form.append("kind", verification.kind);
  form.append("front", front.data, "front.jpg");
  if (selfie.data) form.append("selfie", selfie.data, "selfie.jpg");

  const response = await fetch(`${ocrUrl}/inspect-document`, {
    method: "POST",
    headers: { "x-ocr-token": ocrToken },
    body: form,
  });

  if (!response.ok) {
    console.error("inspect failed", response.status, await response.text());
    throw new HttpError(502, "INSPECT_FAILED");
  }

  const inspection = await response.json() as {
    flags: string[];
    details: Record<string, unknown>;
    phash: string | null;
  };

  // 書き込みは service role のみ。重複検出はこの中で足される。
  const { data: flags, error: recordError } = await admin.rpc("record_document_check", {
    p_verification: verification.id,
    p_phash: inspection.phash,
    p_flags: inspection.flags,
    p_details: inspection.details,
  });

  if (recordError) throw new HttpError(500, recordError.message);

  return json({ flags: flags ?? inspection.flags, details: inspection.details });
}));

// 退会。本人のアカウントとデータを消す。
//
// 順番に意味がある:
//   1. 書類の識別子と「止められていたか」を控える（retire_account）
//      先に消すと控えられず、止められた人が同じ書類で作り直せてしまう
//   2. Storage の書類の画像を消す（auth.users を消しても Storage は残る）
//   3. auth.users を消す。プロフィール・依頼・通報・同意などは cascade で消える
//
// 途中で失敗しても、もう一度呼べば続きからやり直せる（どの段も何度やっても同じ結果）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, HttpError, json, serveJson } from "../_shared/auth.ts";

const BUCKET = "identity-documents";

Deno.serve(serveJson(async (req) => {
  // 消せるのは自分のアカウントだけ。対象は JWT から決め、本文からは受け取らない
  const { userId } = await authenticate(req);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { error: retireError } = await admin.rpc("retire_account", { p_user: userId });
  if (retireError) throw new HttpError(500, `RETIRE_FAILED: ${retireError.message}`);

  const { data: files, error: listError } = await admin.storage.from(BUCKET).list(userId);
  if (listError) throw new HttpError(500, `LIST_FAILED: ${listError.message}`);
  if (files && files.length > 0) {
    const { error: removeError } = await admin.storage
      .from(BUCKET)
      .remove(files.map((f) => `${userId}/${f.name}`));
    if (removeError) throw new HttpError(500, `REMOVE_FAILED: ${removeError.message}`);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) throw new HttpError(500, `DELETE_FAILED: ${deleteError.message}`);

  return json({ deleted: true });
}));

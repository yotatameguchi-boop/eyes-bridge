// 審査が済んだ本人確認書類の画像を消す。
//
// pg_cron から1日1回叩く想定。SQL だけでは消せない
// （Storage の実体はオブジェクトストレージにあり、行を消しても残る）。
//
// 消すのは画像だけで、審査の結果は残す。
// 「いつ誰が承認したか」が消えると、問題が起きたときに辿れなくなる。
import { createClient } from "npm:@supabase/supabase-js@2";
import { json, serveJson } from "../_shared/auth.ts";

const BUCKET = "identity-documents";

Deno.serve(serveJson(async (req) => {
  // 人が叩く関数ではないので、service role key そのものを鍵にする。
  // ユーザーの JWT では通さない。
  const auth = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (auth !== `Bearer ${serviceKey}`) {
    return json({ error: "FORBIDDEN" }, 403);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: rows, error } = await admin.rpc("identity_documents_to_purge");
  if (error) return json({ error: error.message }, 500);

  const targets = (rows ?? []) as { id: string; paths: string[] }[];
  let purged = 0;
  const failed: string[] = [];

  for (const target of targets) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove(target.paths);

    // 消せなかったものは行を書き換えない。
    // 次回の実行でもう一度対象に挙がるようにしておく。
    if (removeError) {
      console.error("remove failed", target.id, removeError.message);
      failed.push(target.id);
      continue;
    }

    const { error: markError } = await admin.rpc("mark_identity_purged", { p_id: target.id });
    if (markError) {
      failed.push(target.id);
      continue;
    }
    purged++;
  }

  return json({ candidates: targets.length, purged, failed });
}));

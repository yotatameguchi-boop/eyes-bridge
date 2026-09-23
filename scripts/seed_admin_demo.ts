// 運営画面を触ってみるためのデモデータ。ローカルの Supabase にだけ入れること。
//
//   deno run --allow-net --allow-env --allow-read scripts/seed_admin_demo.ts          # 入れる
//   deno run --allow-net --allow-env --allow-read scripts/seed_admin_demo.ts --clean  # 消す
//
// 環境変数は e2e_local.ts と同じ（SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY /
// E2E_CARD_JPG / E2E_SELFIE_JPG）。運営としてのログインは
// ops-demo@example.test にメールで6桁コードが届く（ローカルでは Mailpit）。
import { createClient } from "npm:@supabase/supabase-js@2";

const API = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(API, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "identity-documents";
const DEMO = /^demo-.*@example\.test$|^ops-demo@example\.test$/;

async function clean() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const users = (data?.users ?? []).filter((u) => DEMO.test(u.email ?? ""));
  for (const u of users) {
    const files = await admin.storage.from(BUCKET).list(u.id);
    if (files.data?.length) await admin.storage.from(BUCKET).remove(files.data.map((f) => `${u.id}/${f.name}`));
    await admin.auth.admin.deleteUser(u.id);
  }
  console.log(`デモユーザー ${users.length} 人を削除`);
}

if (Deno.args.includes("--clean")) {
  await clean();
  Deno.exit(0);
}
await clean(); // 入れ直せるように、先に古いデモを消す

const card = await Deno.readFile(Deno.env.get("E2E_CARD_JPG")!);
const selfie = await Deno.readFile(Deno.env.get("E2E_SELFIE_JPG")!);

async function user(email: string, name: string, role: "requester" | "volunteer") {
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  await client.auth.signInWithPassword({ email, password });
  await client.from("profiles").insert({ id: data.user.id, role, display_name: name });
  if (role === "volunteer") await client.from("volunteer_status").insert({ user_id: data.user.id });
  return { id: data.user.id, client };
}

async function submit(u: { id: string; client: any }) {
  await u.client.rpc("agree_to_terms");
  const front = `${u.id}/demo-front.jpg`, face = `${u.id}/demo-selfie.jpg`;
  await u.client.storage.from(BUCKET).upload(front, card, { contentType: "image/jpeg" });
  await u.client.storage.from(BUCKET).upload(face, selfie, { contentType: "image/jpeg" });
  const { data } = await u.client.rpc("submit_identity", {
    p_kind: "drivers_license", p_front: front, p_selfie: face, p_back: null,
  });
  const token = (await u.client.auth.getSession()).data.session.access_token;
  const res = await fetch(`${API}/functions/v1/inspect-identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ verificationId: data.id }),
  });
  return (await res.json()).flags as string[];
}

const ops = await user("ops-demo@example.test", "運営デモ", "volunteer");
await admin.from("profiles").update({ is_admin: true }).eq("id", ops.id);

const hanako = await user("demo-hanako@example.test", "見本 花子", "volunteer");
console.log("見本 花子の自動チェック:", await submit(hanako));

const jiro = await user("demo-jiro@example.test", "見本 次郎", "volunteer");
console.log("見本 次郎の自動チェック:", await submit(jiro), "（花子と同じ書類）");

const taro = await user("demo-taro@example.test", "見本 太郎", "requester");
await admin.from("help_requests").insert({
  id: crypto.randomUUID(), requester_id: taro.id, volunteer_id: hanako.id, state: "completed",
}).select().single().then(async ({ data }) => {
  await taro.client.rpc("report_participant", {
    p_request: data.id, p_reason: "privacy",
    p_detail: "頼んでいない書類の裏側を見せるよう何度も言われた（デモ）", p_block: true,
  });
});

console.log("\n運営ログイン: ops-demo@example.test（コードは http://127.0.0.1:54324 の Mailpit に届く）");

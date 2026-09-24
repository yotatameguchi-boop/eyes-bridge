// ローカルの Supabase + Edge Functions + LiveKit + OCR を通しで動かす。
//
// stub の SQL テストや関数単体の型チェックでは分からないこと
// （関数が実際に動くか、Storage と RLS が噛み合うか、発行したトークンを
// LiveKit が受け付けるか）を確かめる。作ったユーザーと画像は最後に消す。
//
// 前提:
//   supabase start
//   supabase functions serve --env-file supabase/functions/.env
//   docker compose up -d livekit ocr
//
// 実行（キーは `supabase status -o env` の値。ローカル既定値で秘密ではない）:
//   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   E2E_CARD_JPG=/path/card.jpg E2E_SELFIE_JPG=/path/selfie.jpg \
//   deno run --allow-net --allow-env --allow-read scripts/e2e_local.ts
//
// card.jpg は日本語の見本（ocr/test_japanese_sample.py と同じ作り方）。
// 実在の書類の画像は使わないこと。
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const API = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LIVEKIT_HTTP = Deno.env.get("LIVEKIT_HTTP") ?? "http://127.0.0.1:7880";
const OCR_HTTP = Deno.env.get("OCR_HTTP") ?? "http://127.0.0.1:8081";
const card = await Deno.readFile(Deno.env.get("E2E_CARD_JPG")!);
const selfie = await Deno.readFile(Deno.env.get("E2E_SELFIE_JPG")!);

const admin = createClient(API, SERVICE, { auth: { persistSession: false } });
const BUCKET = "identity-documents";

// 使い回し検出は DB 全体を見るので、同じ見本画像が既に入っていると
// 「初回の提出」が初回にならない。空の DB を前提にし、違えば先に止める。
{
  const { count } = await admin.from("profiles").select("*", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    console.log(`既存のデータがあります（profiles: ${count} 行）。空の DB で流してください。`);
    console.log("デモデータなら: deno run --allow-net --allow-env --allow-read scripts/seed_admin_demo.ts --clean");
    Deno.exit(1);
  }
}

let failures = 0;
function ok(condition: boolean, label: string, extra = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${!condition && extra ? `  （${extra}）` : ""}`);
}

type User = { id: string; client: SupabaseClient };
const created: string[] = [];
const stamp = Date.now();

async function makeUser(tag: string, role: "requester" | "volunteer"): Promise<User> {
  const email = `e2e-${tag}-${stamp}@example.test`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  created.push(data.user.id);

  const client = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;

  // プロフィールは本人の権限で作る（列権限の経路もここで通る）
  const p = await client.from("profiles").insert({ id: data.user.id, role, display_name: tag });
  if (p.error) throw p.error;
  if (role === "volunteer") {
    const v = await client.from("volunteer_status").insert({ user_id: data.user.id, language: "ja" });
    if (v.error) throw v.error;
  }
  return { id: data.user.id, client };
}

function claimsOf(jwt: string) {
  const body = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(body + "===".slice((body.length + 3) % 4)));
}

async function invoke(user: User | null, name: string, body: unknown, bearer?: string) {
  const res = await fetch(`${API}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${bearer ?? (await user!.client.auth.getSession()).data.session!.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 本文が JSON でない */ }
  return { status: res.status, json, text };
}

async function livekitAccepts(token: string): Promise<boolean> {
  const res = await fetch(`${LIVEKIT_HTTP}/rtc/validate?access_token=${token}`);
  await res.body?.cancel();
  return res.status === 200;
}

async function submitIdentity(user: User) {
  const front = `${user.id}/${stamp}-front.jpg`;
  const face = `${user.id}/${stamp}-selfie.jpg`;
  for (const [path, data] of [[front, card], [face, selfie]] as const) {
    const up = await user.client.storage.from(BUCKET).upload(path, data, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
  }
  const { data, error } = await user.client.rpc("submit_identity", {
    p_kind: "drivers_license", p_front: front, p_selfie: face, p_back: null,
  });
  if (error) throw error;
  return data as { id: string };
}

try {
  const requester = await makeUser("requester", "requester");
  const volunteer = await makeUser("volunteer", "volunteer");
  const other = await makeUser("other", "volunteer");
  const operator = await makeUser("operator", "volunteer");
  await admin.from("profiles").update({ is_admin: true }).eq("id", operator.id);

  console.log("--- 1. 依頼者のトークン ---");
  const req = await requester.client.from("help_requests").insert({ requester_id: requester.id }).select().single();
  ok(!req.error, "依頼を立てられる", req.error?.message);
  const requestId = req.data.id as string;

  const rt = await invoke(requester, "livekit-token", { requestId });
  ok(rt.status === 200, "livekit-token が依頼者にトークンを返す", `HTTP ${rt.status} ${rt.text}`);
  if (rt.status === 200) {
    const claims = claimsOf(rt.json.token);
    ok(JSON.stringify(claims.video.canPublishSources) === '["camera","microphone"]',
      "依頼者はカメラとマイクを出せる", JSON.stringify(claims.video.canPublishSources));
    ok(claims.video.room === req.data.room_name, "入れる部屋はその依頼の部屋だけ");
    ok(await livekitAccepts(rt.json.token), "発行したトークンを LiveKit が受け付ける");
  }

  console.log("--- 1b. 依頼の表を好きに書き換えられない ---");
  const second = await requester.client.from("help_requests").insert({ requester_id: requester.id });
  ok(second.error?.message.includes("REQUEST_ALREADY_OPEN") ?? false,
    "待っている依頼があるうちは2件目を立てられない", second.error?.message);
  const backdated = await requester.client.from("help_requests")
    .insert({ requester_id: requester.id, created_at: "2000-01-01T00:00:00Z" });
  ok(!!backdated.error, "作成時刻をずらして立てられない（上限のすり抜けを防ぐ）");
  const tamper = await requester.client.from("help_requests")
    .update({ state: "queued", rung_at: null }).eq("id", requestId).select();
  ok(!!tamper.error || (tamper.data?.length ?? 0) === 0, "自分の依頼でも直接は書き換えられない",
    JSON.stringify(tamper.data));

  console.log("--- 2. 審査前のボランティア ---");
  const early = await invoke(volunteer, "livekit-token", { requestId });
  ok(early.status === 404 || early.status === 403, "当事者でないボランティアにはトークンを出さない", `HTTP ${early.status}`);
  const earlyClaim = await volunteer.client.rpc("claim_help_request", { p_request: requestId });
  ok(earlyClaim.error?.message.includes("NOT_APPROVED") ?? false, "審査前は依頼を取れない", earlyClaim.error?.message);

  console.log("--- 3. 本人確認と自動チェック ---");
  await volunteer.client.rpc("agree_to_terms");
  const verification = await submitIdentity(volunteer);
  ok(!!verification.id, "書類を Storage に置いて提出できる");

  const peek = await invoke(other, "inspect-identity", { verificationId: verification.id });
  ok(peek.status === 404 || peek.status === 403, "他人の本人確認は検査にかけられない", `HTTP ${peek.status}`);

  const inspected = await invoke(volunteer, "inspect-identity", { verificationId: verification.id });
  ok(inspected.status === 200, "inspect-identity が OCR を通して結果を返す", `HTTP ${inspected.status} ${inspected.text}`);
  if (inspected.status === 200) {
    const d = inspected.json.details;
    ok(d.expiry === "2028-05-01", "見本の有効期限を読める（生年月日・交付日と取り違えない）", String(d.expiry));
    ok(!inspected.json.flags.includes("keywords_missing"), "券面の語を拾える", inspected.json.flags.join(","));
    ok(!inspected.json.flags.includes("duplicate_document"), "初回の提出は使い回し扱いにならない");
  }
  const stored = await operator.client.from("document_checks").select("flags").eq("verification_id", verification.id).single();
  ok(!stored.error && Array.isArray(stored.data?.flags), "自動チェックの結果が保存され、運営から読める", stored.error?.message);

  console.log("--- 4. 同じ書類の使い回し ---");
  await other.client.rpc("agree_to_terms");
  const reused = await submitIdentity(other);
  const reusedCheck = await invoke(other, "inspect-identity", { verificationId: reused.id });
  ok(reusedCheck.json?.flags?.includes("duplicate_document") ?? false,
    "別アカウントが同じ書類を出すと duplicate_document が立つ", JSON.stringify(reusedCheck.json?.flags));

  console.log("--- 5. 運営が承認する ---");
  const notAdmin = await volunteer.client.rpc("review_identity", { p_id: verification.id, p_approve: true });
  ok(notAdmin.error?.message.includes("NOT_AN_ADMIN") ?? false, "運営でない人は審査できない");
  const approveId = await operator.client.rpc("review_identity", { p_id: verification.id, p_approve: true });
  ok(!approveId.error, "運営が本人確認を承認できる", approveId.error?.message);
  const approveVol = await operator.client.rpc("review_volunteer", { p_user: volunteer.id, p_state: "approved" });
  ok(!approveVol.error, "本人確認済みのボランティアを承認できる", approveVol.error?.message);

  console.log("--- 6. 取り合いとボランティアのトークン ---");
  const claim = await volunteer.client.rpc("claim_help_request", { p_request: requestId });
  ok(!claim.error && claim.data?.state === "active", "承認後は依頼を取れる", claim.error?.message);
  const vt = await invoke(volunteer, "livekit-token", { requestId });
  ok(vt.status === 200, "取ったボランティアにトークンが出る", `HTTP ${vt.status} ${vt.text}`);
  if (vt.status === 200) {
    ok(JSON.stringify(claimsOf(vt.json.token).video.canPublishSources) === '["microphone"]',
      "ボランティアはマイクしか出せない");
    ok(await livekitAccepts(vt.json.token), "ボランティアのトークンも LiveKit が受け付ける");
  }

  console.log("--- 7. 通話を終えて、次の依頼と着信 ---");
  // 未処理の依頼は1人1件なので、前の通話を終えてから次を立てる
  const ended = await requester.client.rpc("end_help_request", { p_request: requestId, p_state: "completed" });
  ok(!ended.error, "依頼者は通話を終えられる", ended.error?.message);
  const req2 = await requester.client.from("help_requests").insert({ requester_id: requester.id }).select().single();
  ok(!req2.error, "通話を終えれば次の依頼を立てられる", req2.error?.message);
  const ring = await invoke(requester, "ring-volunteers", { requestId: req2.data.id });
  ok(ring.status === 200, "ring-volunteers が動く", `HTTP ${ring.status} ${ring.text}`);
  const ringAgain = await invoke(requester, "ring-volunteers", { requestId: req2.data.id });
  ok(ringAgain.status === 409 && ringAgain.json?.error === "ALREADY_RUNG",
    "同じ依頼で2回目の着信は送れない（着信の連打を防ぐ）", `HTTP ${ringAgain.status} ${ringAgain.text}`);
  const ringByOther = await invoke(volunteer, "ring-volunteers", { requestId: req2.data.id });
  ok(ringByOther.status === 403, "依頼者以外は着信を送れない", `HTTP ${ringByOther.status}`);

  console.log("--- 7b. 写真の読み取り ---");
  const post = async (url: string, headers: Record<string, string>) => {
    const form = new FormData();
    form.append("image", new Blob([card], { type: "image/jpeg" }), "card.jpg");
    const res = await fetch(url, { method: "POST", headers, body: form });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* JSON でない */ }
    return { status: res.status, body };
  };
  const direct = await post(`${OCR_HTTP}/ocr`, {});
  ok(direct.status === 403, "OCR サーバは鍵なしでは直接使えない", `HTTP ${direct.status}`);
  const anon = await post(`${API}/functions/v1/read-image`, { apikey: ANON, Authorization: `Bearer ${ANON}` });
  ok(anon.status === 401, "ログインしていなければ読み取りは使えない", `HTTP ${anon.status}`);
  const token = (await requester.client.auth.getSession()).data.session!.access_token;
  const read = await post(`${API}/functions/v1/read-image`, { apikey: ANON, Authorization: `Bearer ${token}` });
  ok(read.status === 200 && read.body?.text?.includes("運転免許証"),
    "ログインしていれば read-image を通して読める", `HTTP ${read.status}`);
  ok(Array.isArray(read.body?.blocks?.[0]?.box) && typeof read.body?.frame?.blur === "number",
    "撮影の案内に使う位置と写り方も返る");

  console.log("--- 8. 通報 ---");
  const report = await requester.client.rpc("report_participant", {
    p_request: requestId, p_reason: "privacy", p_detail: "e2e", p_block: true,
  });
  ok(!report.error, "当事者は通報できる", report.error?.message);
  const seen = await operator.client.from("reports").select("id").eq("request_id", requestId);
  ok((seen.data?.length ?? 0) === 1, "運営は通報を読める");

  console.log("--- 9. 審査済み画像の削除 ---");
  await admin.from("identity_verifications")
    .update({ purge_after: new Date(Date.now() - 86_400_000).toISOString() })
    .eq("id", verification.id);

  const purgeByUser = await invoke(volunteer, "purge-identity-documents", {});
  ok(purgeByUser.status === 403, "利用者の JWT では削除を起動できない", `HTTP ${purgeByUser.status}`);

  const purge = await invoke(null, "purge-identity-documents", {}, SERVICE);
  ok(purge.status === 200 && purge.json?.purged >= 1, "service role で期限切れの画像を消せる", `HTTP ${purge.status} ${purge.text}`);

  const left = await admin.storage.from(BUCKET).list(volunteer.id);
  ok((left.data?.length ?? -1) === 0, "Storage から実体が消えている", `残り ${left.data?.length}`);
  const row = await admin.from("identity_verifications").select("state, front_path").eq("id", verification.id).single();
  ok(row.data?.state === "approved" && row.data?.front_path === "", "審査の結果は残り、画像への参照だけ消える");
} catch (e) {
  failures++;
  console.log("FAIL  途中で例外:", e instanceof Error ? e.message : e);
} finally {
  // 後片付け。画像 → ユーザー（プロフィール以下は cascade で消える）
  for (const id of created) {
    const files = await admin.storage.from(BUCKET).list(id);
    if (files.data?.length) {
      await admin.storage.from(BUCKET).remove(files.data.map((f) => `${id}/${f.name}`));
    }
    await admin.auth.admin.deleteUser(id);
  }
  console.log(`\n後片付け: ユーザー ${created.length} 人と画像を削除`);
}

console.log(failures ? `\n${failures} 件落ちました` : "\nすべて通りました");
Deno.exit(failures ? 1 : 0);

// 待機中のボランティアを、段階的に鳴らす。
//
// 以前は1つの依頼で最大50人を一度に鳴らしていた。取れるのは1人だけなので、
// 残りの49人は「鳴ったのに出たら終わっていた」を繰り返し、離れていく。
// 今は、最初に数人（既定 5人）、誰も取らなければ間隔（既定 15秒）ごとに
// 次の数人（15人 → 30人）を鳴らす。誰かが取った時点で次の段は鳴らない。
// 誰を選ぶか（審査済み・待機中・鳴らさない時間帯でない・ブロック関係に無い・
// まだ鳴らしていない）は DB の take_ring_wave が1つの処理で決める。
//
// 2段目以降は応答を返したあとに裏で続ける（EdgeRuntime.waitUntil）。
// 依頼者のアプリを待たせないため。
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authenticate, HttpError, json, serveJson } from "../_shared/auth.ts";
import { sendVoipPush } from "../_shared/apns.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// 段の大きさと間隔。手元の検証では間隔を縮める（supabase/functions/.env）
const WAVE_SIZES = (Deno.env.get("RING_WAVE_SIZES") ?? "5,15,30")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);
const WAVE_SECONDS = Number(Deno.env.get("RING_WAVE_SECONDS") ?? "15");
// 手元では外部（Expo / APNs）に送らない。誰を選んだかの記録だけ残す
const DRY_RUN = Deno.env.get("RING_DRY_RUN") === "true";

type Target = { user_id: string; push_token: string; push_kind: string };
type Request = { id: string; room_name: string; language: string };

async function sendExpoPush(targets: Target[], requestId: string, roomName: string) {
  if (targets.length === 0) return 0;

  const messages = targets.map((t) => ({
    to: t.push_token,
    title: "見てほしい人がいます",
    body: "タップして応答",
    sound: "default",
    priority: "high",
    // 通知そのものより、アプリ側で着信画面を出すためのデータが本体
    data: { type: "incoming_request", requestId, roomName },
    ttl: 60,
  }));

  const res = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    console.error("Expo push failed", res.status, await res.text());
    return 0;
  }
  return targets.length;
}

/** 1段分を鳴らす。鳴らした人数を返す（依頼がもう待っていなければ 0） */
async function ringWave(admin: SupabaseClient, request: Request, wave: number, size: number) {
  const { data, error } = await admin.rpc("take_ring_wave", {
    p_request: request.id,
    p_wave: wave,
    p_limit: size,
  });
  if (error) {
    console.error("take_ring_wave failed", error.message);
    return 0;
  }

  const targets = (data ?? []) as Target[];
  if (targets.length === 0 || DRY_RUN) return targets.length;

  const voip = targets.filter((t) => t.push_kind === "apns_voip");
  const expo = targets.filter((t) => t.push_kind !== "apns_voip");

  const voipResults = await Promise.all(
    voip.map((t) =>
      sendVoipPush(t.push_token, {
        requestId: request.id,
        roomName: request.room_name,
        callerName: "依頼", // 依頼者の名前は出さない。通知画面は誰でも覗ける
        language: request.language,
      })
    ),
  );

  return voipResults.filter(Boolean).length + await sendExpoPush(expo, request.id, request.room_name);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(serveJson(async (req) => {
  const { userId, db } = await authenticate(req);

  const { requestId } = await req.json().catch(() => ({}));
  if (typeof requestId !== "string") throw new HttpError(400, "MISSING_REQUEST_ID");

  // 依頼者本人からの呼び出しであることを、その人の権限で確認する
  const { data: request, error } = await db
    .from("help_requests")
    .select("id, room_name, state, language, requester_id")
    .eq("id", requestId)
    .single();

  if (error || !request) throw new HttpError(404, "REQUEST_NOT_FOUND");
  if (request.requester_id !== userId) throw new HttpError(403, "NOT_THE_REQUESTER");
  if (request.state !== "queued") throw new HttpError(409, "REQUEST_NOT_QUEUED");

  // 着信を始められるのは1依頼につき1回だけ（着信の連打を防ぐ）。
  // 「鳴らした」印は DB で1回だけ付くので、同時に呼ばれても始まるのは1回。
  const { data: first, error: markError } = await db.rpc("mark_request_rung", {
    p_request: request.id,
  });
  if (markError) throw new HttpError(500, markError.message);
  if (first !== true) throw new HttpError(409, "ALREADY_RUNG");

  // 宛先の選択は service role で行う（他人の通知先は依頼者に見せない）
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const rung = await ringWave(admin, request, 1, WAVE_SIZES[0] ?? 5);

  const rest = (async () => {
    for (let i = 1; i < WAVE_SIZES.length; i++) {
      await sleep(WAVE_SECONDS * 1000);
      // 誰かが取った・取り下げた依頼は、次の段を鳴らさない（take_ring_wave も弾く）
      const { data: now } = await admin.from("help_requests").select("state").eq("id", request.id).single();
      if (now?.state !== "queued") return;
      await ringWave(admin, request, i + 1, WAVE_SIZES[i]);
    }
  })().catch((e) => console.error("ring wave failed", e));

  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(rest);

  return json({ rung, waves: WAVE_SIZES.length, intervalSeconds: WAVE_SECONDS, dryRun: DRY_RUN });
}));

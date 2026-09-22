// 待機中のボランティア全員を同時に鳴らす。
//
// 1人ずつ順番に鳴らす設計にはしない。夜間は在席率が落ちるので、
// 順番待ちにすると依頼者が数十秒待たされる。全員に鳴らして
// 最初に取った1人が勝つ（取り合いは claim_help_request が捌く）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, HttpError, json, serveJson } from "../_shared/auth.ts";
import { sendVoipPush } from "../_shared/apns.ts";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const FANOUT_LIMIT = 50; // 1依頼で鳴らす上限。全国の全員を叩くと通知疲れで離脱する

type Target = { user_id: string; push_token: string; push_kind: string };

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

  // 宛先の取得だけは service-role で行う。
  // 他人の push トークンは RLS で依頼者に見せていないため。
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 依頼者がブロックした相手／依頼者をブロックした相手は鳴らさない。
  // RLS 側でも取得を弾いているが、通知が飛ぶだけで相手には
  // 「誰かが助けを求めた」と伝わってしまうので、送信段階で落とす。
  const { data: blockRows } = await admin
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${request.requester_id},blocked_id.eq.${request.requester_id}`);

  const excluded = new Set(
    (blockRows ?? []).map((b: { blocker_id: string; blocked_id: string }) =>
      b.blocker_id === request.requester_id ? b.blocked_id : b.blocker_id
    ),
  );

  const { data: volunteers } = await admin
    .from("volunteer_status")
    .select("user_id, push_token, push_kind")
    .eq("is_available", true)
    .eq("language", request.language)
    // 審査を通っていない人には依頼の存在自体を知らせない
    .eq("review_state", "approved")
    .not("agreed_to_terms_at", "is", null)
    .not("push_token", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(FANOUT_LIMIT);

  const targets = ((volunteers ?? []) as Target[]).filter((t) => !excluded.has(t.user_id));
  const voip = targets.filter((t) => t.push_kind === "apns_voip");
  const expo = targets.filter((t) => t.push_kind !== "apns_voip");

  const voipResults = await Promise.all(
    voip.map((t) =>
      sendVoipPush(t.push_token, {
        requestId: request.id,
        roomName: request.room_name,
        callerName: "依頼",           // 依頼者の名前は出さない。通知画面は誰でも覗ける
        language: request.language,
      })
    ),
  );

  const rung = voipResults.filter(Boolean).length +
    await sendExpoPush(expo, request.id, request.room_name);

  return json({ rung, availableTargets: targets.length });
}));

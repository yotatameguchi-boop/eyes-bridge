// LiveKit の入室トークンを発行する。
//
// クライアントに API シークレットを持たせない。持たせると
// 任意の部屋に入れてしまい、他人の通話を覗けるため。
// ここで「その人が本当にその依頼の当事者か」を DB に問い合わせて確かめる。
import { AccessToken } from "npm:livekit-server-sdk@2";
import { authenticate, HttpError, json, serveJson } from "../_shared/auth.ts";

const TTL_SECONDS = 60 * 30; // 通話1回分。長めに切れると再入室できない

Deno.serve(serveJson(async (req) => {
  const { userId, db } = await authenticate(req);

  const { requestId } = await req.json().catch(() => ({}));
  if (typeof requestId !== "string") throw new HttpError(400, "MISSING_REQUEST_ID");

  // RLS が効いているので、当事者でなければそもそも行が返らない。
  // ただし待機中(queued)の行は全ボランティアに見えるので、
  // 「当事者である」ことをここで明示的に確認する。
  const { data: request, error } = await db
    .from("help_requests")
    .select("id, room_name, state, requester_id, volunteer_id")
    .eq("id", requestId)
    .single();

  if (error || !request) throw new HttpError(404, "REQUEST_NOT_FOUND");

  const isRequester = request.requester_id === userId;
  const isVolunteer = request.volunteer_id === userId;
  if (!isRequester && !isVolunteer) throw new HttpError(403, "NOT_A_PARTICIPANT");
  if (request.state !== "active" && request.state !== "queued") {
    throw new HttpError(409, "REQUEST_NOT_JOINABLE");
  }

  const token = new AccessToken(
    Deno.env.get("LIVEKIT_API_KEY")!,
    Deno.env.get("LIVEKIT_API_SECRET")!,
    { identity: userId, ttl: TTL_SECONDS },
  );

  token.addGrant({
    room: request.room_name,
    roomJoin: true,
    // 依頼者だけがカメラを出す。ボランティアは声だけ。
    // 「見る側の顔が映らない」ことが依頼者の心理的な敷居を大きく下げる。
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: isRequester ? ["camera", "microphone"] : ["microphone"],
  });

  return json({
    token: await token.toJwt(),
    url: Deno.env.get("LIVEKIT_URL"),
    roomName: request.room_name,
    role: isRequester ? "requester" : "volunteer",
  });
}));

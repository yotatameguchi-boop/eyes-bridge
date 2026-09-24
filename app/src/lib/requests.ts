// 待機列の読み書き。画面はここしか触らない。
import { supabase, type HelpRequest, type RequestState } from "./supabase";

export type QueueHandle = { unsubscribe: () => void };

/** 依頼を立てられなかった理由。画面はこれを見て言うことを変える。 */
export type RequestErrorCode = "ALREADY_OPEN" | "RATE_LIMITED" | "BLOCKED" | "FAILED";

export class RequestError extends Error {
  constructor(readonly code: RequestErrorCode) {
    super(code);
  }
}

function requestErrorCode(message: string): RequestErrorCode {
  if (message.includes("REQUEST_ALREADY_OPEN")) return "ALREADY_OPEN";
  if (message.includes("RATE_LIMITED")) return "RATE_LIMITED";
  if (message.includes("REQUESTER_BLOCKED")) return "BLOCKED";
  return "FAILED";
}

/** 依頼を立てて、待機中のボランティアを鳴らす。 */
export async function createHelpRequest(language = "ja"): Promise<HelpRequest> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new RequestError("FAILED");
  const me = auth.user.id;

  const insert = () =>
    supabase.from("help_requests").insert({ requester_id: me, language }).select().single();

  let { data, error } = await insert();

  // 未処理の依頼は1人1件まで（DB で強制している）。
  // アプリが落ちて、前の依頼が「待っている」まま残っていることがある。
  // 自分の待っている依頼なら取り下げて、1回だけ立て直す。
  // 通話中の依頼が残っている場合は立て直さない（ALREADY_OPEN を返す）。
  if (error && requestErrorCode(error.message) === "ALREADY_OPEN") {
    const { data: stale } = await supabase
      .from("help_requests")
      .select("id")
      .eq("requester_id", me)
      .eq("state", "queued");
    if (stale && stale.length > 0) {
      await Promise.all(stale.map((r) => endRequest(r.id as string, "cancelled")));
      ({ data, error } = await insert());
    }
  }

  if (error || !data) throw new RequestError(error ? requestErrorCode(error.message) : "FAILED");

  // 鳴らすのに失敗しても依頼自体は生きている。
  // Presence でアプリを開いている人には Realtime で届くので、
  // ここで例外を投げて依頼ごと落とすことはしない。
  supabase.functions
    .invoke("ring-volunteers", { body: { requestId: data.id } })
    .catch((e) => console.warn("ring-volunteers failed", e));

  return data as HelpRequest;
}

/** 自分の依頼の状態変化（= 誰かが取った）を待つ。 */
export function watchRequest(
  requestId: string,
  onChange: (request: HelpRequest) => void,
): QueueHandle {
  const channel = supabase
    .channel(`request:${requestId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "help_requests", filter: `id=eq.${requestId}` },
      (payload) => onChange(payload.new as HelpRequest),
    )
    .subscribe();

  return { unsubscribe: () => void supabase.removeChannel(channel) };
}

/** ボランティア側。新しい依頼が立った瞬間を拾う。 */
export function watchQueue(
  language: string,
  onIncoming: (request: HelpRequest) => void,
): QueueHandle {
  const channel = supabase
    .channel(`queue:${language}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "help_requests" },
      (payload) => {
        const request = payload.new as HelpRequest;
        if (request.language === language && request.state === "queued") onIncoming(request);
      },
    )
    .subscribe();

  return { unsubscribe: () => void supabase.removeChannel(channel) };
}

/** 画面を開いた時点で既に並んでいる依頼。Realtime は「今後の変化」しか流さない。 */
export async function fetchQueued(language: string): Promise<HelpRequest[]> {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("state", "queued")
    .eq("language", language)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as HelpRequest[];
}

export class AlreadyTakenError extends Error {
  constructor() {
    super("ALREADY_TAKEN");
  }
}

/**
 * 依頼を取る。同時に押された場合、勝つのは1人だけ。
 * 負けた側には AlreadyTakenError が返る（エラーではなく通常の分岐として扱う）。
 */
export async function claimRequest(requestId: string): Promise<HelpRequest> {
  const { data, error } = await supabase.rpc("claim_help_request", { p_request: requestId });

  if (error) {
    if (error.message.includes("ALREADY_TAKEN")) throw new AlreadyTakenError();
    throw error;
  }
  return data as HelpRequest;
}

export async function endRequest(
  requestId: string,
  state: Extract<RequestState, "completed" | "cancelled">,
): Promise<void> {
  const { error } = await supabase.rpc("end_help_request", {
    p_request: requestId,
    p_state: state,
  });
  // 相手が先に切った場合もここに来る。二重終了は失敗ではない。
  if (error && !error.message.includes("NOT_FOUND_OR_NOT_PARTICIPANT")) throw error;
}

export async function getRequest(requestId: string): Promise<HelpRequest | null> {
  const { data } = await supabase.from("help_requests").select("*").eq("id", requestId).single();
  return (data as HelpRequest) ?? null;
}

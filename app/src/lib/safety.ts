// 審査・通報・ブロック。
//
// ここに書いてあることは全部サーバ側でも強制されている。
// 画面でボタンを隠すのは親切のためで、守りではない。
import { fetchIdentity, type IdentityState } from "./identity";
import { supabase } from "./supabase";

export type ReviewState = "pending" | "approved" | "suspended" | "rejected";

export type VolunteerStanding = {
  reviewState: ReviewState;
  agreedToTerms: boolean;
  acceptedCount: number;
  /** 本人確認を一度も出していなければ null */
  identityState: IdentityState | null;
  identityRejectReason: string;
};

export type ReportReason =
  | "inappropriate"
  | "privacy"
  | "harassment"
  | "no_help"
  | "other";

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "privacy", label: "見せていないものを見ようとした" },
  { value: "inappropriate", label: "不適切な発言があった" },
  { value: "harassment", label: "しつこく絡まれた" },
  { value: "no_help", label: "繋がったが何もしてくれなかった" },
  { value: "other", label: "その他" },
];

export async function fetchStanding(userId: string): Promise<VolunteerStanding | null> {
  const [{ data }, identity] = await Promise.all([
    supabase
      .from("volunteer_status")
      .select("review_state, agreed_to_terms_at, accepted_count")
      .eq("user_id", userId)
      .maybeSingle(),
    fetchIdentity(userId).catch(() => null),
  ]);

  if (!data) return null;

  return {
    reviewState: data.review_state as ReviewState,
    agreedToTerms: data.agreed_to_terms_at !== null,
    acceptedCount: data.accepted_count ?? 0,
    identityState: identity?.state ?? null,
    identityRejectReason: identity?.rejectReason ?? "",
  };
}

export async function agreeToTerms(): Promise<void> {
  const { error } = await supabase.rpc("agree_to_terms");
  if (error) throw error;
}

/**
 * 通報する。相手が誰かはサーバが通話記録から決める。
 * クライアントに相手を指定させると、無関係な人を通報できてしまう。
 */
export async function reportParticipant(
  requestId: string,
  reason: ReportReason,
  detail = "",
  alsoBlock = true,
): Promise<void> {
  const { error } = await supabase.rpc("report_participant", {
    p_request: requestId,
    p_reason: reason,
    p_detail: detail,
    p_block: alsoBlock,
  });
  if (error) throw error;
}

/** 通報するほどではないが、もう繋がりたくない相手。 */
export async function blockCounterpart(requestId: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("NOT_SIGNED_IN");

  const { data: request } = await supabase
    .from("help_requests")
    .select("requester_id, volunteer_id")
    .eq("id", requestId)
    .single();

  if (!request) throw new Error("REQUEST_NOT_FOUND");

  const target =
    request.requester_id === auth.user.id ? request.volunteer_id : request.requester_id;
  if (!target) throw new Error("NO_COUNTERPART");

  const { error } = await supabase
    .from("blocks")
    .insert({ blocker_id: auth.user.id, blocked_id: target });

  // 既にブロック済みは成功として扱う
  if (error && !error.message.includes("duplicate key")) throw error;
}

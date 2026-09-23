// 本人確認書類の提出。
//
// 個人番号（マイナンバー）は扱わない。
//   番号法20条で、個人番号の収集・保管は社会保障・税・災害対策の
//   事務に限られている。ボランティアのマッチングはどれにも当たらない。
//   マイナンバーカードは本人確認書類としては使えるので、
//   表面だけを受け取り、個人番号が印字された裏面は撮らせない。
//
// 書類番号も読み取らない。要るのは「本人かどうか」であって番号ではない。
import { decode } from "base64-arraybuffer";
import { supabase } from "./supabase";

export type IdentityKind =
  | "drivers_license"
  | "my_number_card"
  | "passport"
  | "residence_card";

export type IdentityState = "submitted" | "approved" | "rejected";

export type IdentityRecord = {
  id: string;
  kind: IdentityKind;
  state: IdentityState;
  rejectReason: string;
  submittedAt: string;
};

export const ID_KINDS: {
  value: IdentityKind;
  label: string;
  needsBack: boolean;
  note?: string;
}[] = [
  { value: "drivers_license", label: "運転免許証", needsBack: true },
  {
    value: "my_number_card",
    label: "マイナンバーカード",
    needsBack: false,
    // ここを撮らせない理由を、必ず本人に見える形で書く
    note: "表面だけを撮ってください。個人番号が書かれた裏面は受け取れません。",
  },
  { value: "passport", label: "パスポート", needsBack: false },
  { value: "residence_card", label: "在留カード", needsBack: true },
];

/** 直近の提出。無ければ null。 */
export async function fetchIdentity(userId: string): Promise<IdentityRecord | null> {
  const { data } = await supabase
    .from("identity_verifications")
    .select("id, kind, state, reject_reason, submitted_at")
    .eq("user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  return {
    id: data.id,
    kind: data.kind as IdentityKind,
    state: data.state as IdentityState,
    rejectReason: data.reject_reason ?? "",
    submittedAt: data.submitted_at,
  };
}

export type Shots = {
  frontBase64: string;
  selfieBase64: string;
  backBase64?: string;
};

const BUCKET = "identity-documents";

async function upload(userId: string, base64: string, label: string): Promise<string> {
  // パスは必ず自分の user_id から始める。
  // Storage のポリシーと submit_identity の両方がこれを見ている。
  const path = `${userId}/${Date.now()}-${label}.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: false });

  if (error) throw error;
  return path;
}

export async function submitIdentity(
  userId: string,
  kind: IdentityKind,
  shots: Shots,
): Promise<void> {
  if (kind === "my_number_card" && shots.backBase64) {
    // 呼び出し側の事故を握り潰さない。DB 側でも弾くが、
    // ここで止めれば個人番号の画像がそもそもアップロードされない。
    throw new Error("MY_NUMBER_BACK_NOT_ACCEPTED");
  }

  const frontPath = await upload(userId, shots.frontBase64, "front");
  const selfiePath = await upload(userId, shots.selfieBase64, "selfie");
  const backPath = shots.backBase64
    ? await upload(userId, shots.backBase64, "back")
    : null;

  const { error } = await supabase.rpc("submit_identity", {
    p_kind: kind,
    p_front: frontPath,
    p_selfie: selfiePath,
    p_back: backPath,
  });

  if (error) throw error;
}

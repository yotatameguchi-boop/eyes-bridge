import { supabase } from "./supabase";

export type IdentityKind =
  | "drivers_license"
  | "my_number_card"
  | "passport"
  | "residence_card";

export const KIND_LABEL: Record<IdentityKind, string> = {
  drivers_license: "運転免許証",
  my_number_card: "マイナンバーカード（表面）",
  passport: "パスポート",
  residence_card: "在留カード",
};

export type Submission = {
  id: string;
  user_id: string;
  kind: IdentityKind;
  state: "submitted" | "approved" | "rejected";
  front_path: string;
  back_path: string | null;
  selfie_path: string;
  submitted_at: string;
  reject_reason: string;
  check: DocumentCheck | null;
  displayName: string;
};

export type DocumentCheck = {
  flags: string[];
  details: Record<string, unknown>;
  checked_at: string;
};

/**
 * 自動チェックが立てた旗の説明。
 *
 * strength は「これ単独で却下していいか」。
 *   hard … 人が見るまでもなく差し戻してよい
 *   soft … 理由になり得るが、単独では却下しない
 *   weak … 誤検知が多い。他の材料と合わせて見る
 */
export const FLAG_INFO: Record<
  string,
  { label: string; strength: "hard" | "soft" | "weak"; note: string }
> = {
  expired: {
    label: "有効期限が切れている",
    strength: "hard",
    note: "券面から読んだ期限が過去。差し戻してよい。",
  },
  unreadable: {
    label: "文字が読み取れない",
    strength: "hard",
    note: "暗い・ぶれている・小さい。偽造以前に審査できないので撮り直してもらう。",
  },
  keywords_missing: {
    label: "その書類にあるはずの語が無い",
    strength: "soft",
    note: "違う紙を撮っている可能性。ただし反射や切れで語を拾えないこともある。",
  },
  duplicate_document: {
    label: "同じ人の書類が別のアカウントでも使われている",
    strength: "soft",
    note: "券面の氏名と生年月日が、別のアカウントの書類と一致した。使い回しか、家族の書類を借りているか、同じ人が2つ目のアカウントを作ったか。本物であってもここに出る。",
  },
  fingerprint_unavailable: {
    label: "使い回しを確かめられなかった",
    strength: "weak",
    note: "券面から氏名か生年月日を読み取れなかったため、別のアカウントの書類と照合していない。目で確かめる。",
  },
  no_face_in_document: {
    label: "書類に顔が見つからない",
    strength: "soft",
    note: "顔写真のある面を撮っていない可能性。検出漏れもある。",
  },
  no_face_in_selfie: {
    label: "自撮りに顔が見つからない",
    strength: "soft",
    note: "撮り直してもらう。",
  },
  multiple_faces_in_selfie: {
    label: "自撮りに複数の顔",
    strength: "weak",
    note: "背景に人が写っているだけのことが多い。",
  },
  possible_screen_capture: {
    label: "画面を撮り直した疑い",
    strength: "weak",
    note: "モアレが強い。布や網戸ごしでも上がるので、これだけでは判断しない。",
  },
  expiry_not_found: {
    label: "有効期限を読めなかった",
    strength: "weak",
    note: "期限の記載位置は書類ごとに違う。目で確認する。",
  },
};

export async function isAdmin(): Promise<boolean> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return false;

  const { data } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", auth.user.id)
    .maybeSingle();

  return data?.is_admin === true;
}

export async function fetchSubmissions(
  state: "submitted" | "approved" | "rejected",
): Promise<Submission[]> {
  const { data, error } = await supabase
    .from("identity_verifications")
    .select(
      "id, user_id, kind, state, front_path, back_path, selfie_path, submitted_at, reject_reason",
    )
    .eq("state", state)
    .order("submitted_at", { ascending: true });

  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const ids = rows.map((r) => r.id);

  const [{ data: profiles }, { data: checks }] = await Promise.all([
    supabase.from("profiles").select("id, display_name").in("id", userIds),
    supabase
      .from("document_checks")
      .select("verification_id, flags, details, checked_at")
      .in("verification_id", ids),
  ]);

  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.display_name as string]));
  const checkOf = new Map((checks ?? []).map((c) => [c.verification_id, c]));

  return rows.map((r) => {
    const check = checkOf.get(r.id);
    return {
      ...r,
      displayName: nameOf.get(r.user_id) || "(名前未設定)",
      check: check
        ? {
            flags: (check.flags ?? []) as string[],
            details: (check.details ?? {}) as Record<string, unknown>,
            checked_at: check.checked_at as string,
          }
        : null,
    } as Submission;
  });
}

/** 書類の画像は署名付き URL で短時間だけ開く。公開バケットにはしない。 */
export async function signedUrl(path: string, seconds = 300): Promise<string | null> {
  const { data } = await supabase.storage
    .from("identity-documents")
    .createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

export async function reviewIdentity(id: string, approve: boolean, reason = ""): Promise<void> {
  const { error } = await supabase.rpc("review_identity", {
    p_id: id,
    p_approve: approve,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function runInspection(verificationId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("inspect-identity", {
    body: { verificationId },
  });
  if (error) throw error;
}

export type VolunteerRow = {
  user_id: string;
  review_state: "pending" | "approved" | "suspended" | "rejected";
  is_available: boolean;
  accepted_count: number;
  agreed_to_terms_at: string | null;
  displayName: string;
  identityApproved: boolean;
};

export async function fetchVolunteers(): Promise<VolunteerRow[]> {
  const { data, error } = await supabase
    .from("volunteer_status")
    .select("user_id, review_state, is_available, accepted_count, agreed_to_terms_at")
    .order("review_state");

  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.user_id);
  const [{ data: profiles }, { data: verified }] = await Promise.all([
    supabase.from("profiles").select("id, display_name").in("id", ids),
    supabase
      .from("identity_verifications")
      .select("user_id")
      .eq("state", "approved")
      .in("user_id", ids),
  ]);

  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.display_name as string]));
  const verifiedSet = new Set((verified ?? []).map((v) => v.user_id as string));

  return rows.map((r) => ({
    ...r,
    displayName: nameOf.get(r.user_id) || "(名前未設定)",
    identityApproved: verifiedSet.has(r.user_id),
  })) as VolunteerRow[];
}

export async function reviewVolunteer(
  userId: string,
  state: VolunteerRow["review_state"],
): Promise<void> {
  const { error } = await supabase.rpc("review_volunteer", {
    p_user: userId,
    p_state: state,
  });
  if (error) throw error;
}

export type ReportRow = {
  id: string;
  request_id: string;
  reporter_id: string;
  reported_id: string;
  reason: string;
  detail: string;
  created_at: string;
  handled_at: string | null;
  reportedName: string;
  reportedRole: "requester" | "volunteer";
  /** 依頼者の利用停止（通報が3人から集まると自動で掛かる） */
  reportedBlocked: boolean;
};

export const REASON_LABEL: Record<string, string> = {
  privacy: "見せていないものを見ようとした",
  inappropriate: "不適切な発言",
  harassment: "しつこく絡まれた",
  no_help: "何もしてくれなかった",
  other: "その他",
};

export async function fetchReports(onlyOpen: boolean): Promise<ReportRow[]> {
  let query = supabase
    .from("reports")
    .select("id, request_id, reporter_id, reported_id, reason, detail, created_at, handled_at")
    .order("created_at", { ascending: false });

  if (onlyOpen) query = query.is("handled_at", null);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.reported_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, role, is_blocked")
    .in("id", ids);

  const profileOf = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  return rows.map((r) => {
    const p = profileOf.get(r.reported_id);
    return {
      ...r,
      reportedName: (p?.display_name as string) || "(名前未設定)",
      reportedRole: (p?.role as "requester" | "volunteer") ?? "requester",
      reportedBlocked: p?.is_blocked === true,
    };
  }) as ReportRow[];
}

/**
 * 利用停止を掛ける・外す。依頼者にとっては「助けを呼べなくなる」ことなので、
 * 通報で自動的に止まった人を運営が見直して外せるようにしてある。
 */
export async function setUserBlocked(userId: string, blocked: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_user_blocked", { p_user: userId, p_blocked: blocked });
  if (error) throw error;
}

export async function handleReport(id: string): Promise<void> {
  const { error } = await supabase.rpc("handle_report", { p_id: id });
  if (error) throw error;
}

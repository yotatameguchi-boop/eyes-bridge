import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { PRIVACY, SENSITIVE, TERMS } from "../legal/documents";

export type Role = "requester" | "volunteer";

export type Profile = {
  id: string;
  role: Role;
  display_name: string;
  language: string;
};

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);

    supabase
      .from("profiles")
      .select("id, role, display_name, language")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        setProfile((data as Profile) ?? null);
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [session?.user?.id]);

  return { session, profile, loading, setProfile };
}

/** 役割を決める。初回のみ。あとから変えたい場合は同じ関数で上書きする。 */
/**
 * 同意と一緒に役割を登録する。
 *
 * 役割は profiles に直接は書けない（DB で塞いである）。register_role が
 * 同意の記録と役割の保存を1つの処理で行う。依頼者として登録することは
 * 要配慮個人情報の取得になるので、同意が無ければ DB が断る。
 * 渡す版は、利用者が画面で読んだ文書の版（documents.ts）。
 */
export async function registerRole(role: Role, displayName = ""): Promise<Profile> {
  const { data, error } = await supabase.rpc("register_role", {
    p_role: role,
    p_display_name: displayName,
    p_terms: TERMS.version,
    p_privacy: PRIVACY.version,
    p_sensitive: role === "requester" ? SENSITIVE.version : null,
  });
  if (error) throw error;
  const p = data as Profile & Record<string, unknown>;
  return { id: p.id, role: p.role, display_name: p.display_name, language: p.language };
}

/** 文書の版が上がったときの同意し直し */
export async function reconsent(role: Role): Promise<void> {
  const { error } = await supabase.rpc("reconsent", {
    p_terms: TERMS.version,
    p_privacy: PRIVACY.version,
    p_sensitive: role === "requester" ? SENSITIVE.version : null,
  });
  if (error) throw error;
}

/** 今の版で足りない同意（空なら何も要らない） */
export async function fetchMissingConsents(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_missing_consents");
  if (error) throw error;
  return (data as string[] | null) ?? [];
}

/**
 * 退会する。アカウントとデータを消し、ログアウトする。
 * 消すのはサーバ（delete-account）。対象は自分のアカウントだけ。
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke("delete-account", { body: {} });
  if (error) throw error;
  await supabase.auth.signOut();
}

export async function signOut() {
  await supabase.auth.signOut();
}

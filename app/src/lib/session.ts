import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

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
export async function chooseRole(role: Role, displayName = ""): Promise<Profile> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("NOT_SIGNED_IN");

  const { data, error } = await supabase
    .from("profiles")
    .upsert({ id: auth.user.id, role, display_name: displayName, language: "ja" })
    .select("id, role, display_name, language")
    .single();

  if (error) throw error;

  if (role === "volunteer") {
    await supabase
      .from("volunteer_status")
      .upsert({ user_id: auth.user.id, is_available: false, language: "ja" });
  }

  return data as Profile;
}

export async function signOut() {
  await supabase.auth.signOut();
}

import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // RN には URL バーが無いので、マジックリンクは Linking から自分で流し込む
    detectSessionInUrl: false,
  },
  realtime: {
    // 待機列は「今すぐ」でないと意味が無い。既定より速く流す。
    params: { eventsPerSecond: 20 },
  },
});

export type RequestState = "queued" | "active" | "completed" | "cancelled" | "timed_out";

export type HelpRequest = {
  id: string;
  requester_id: string;
  volunteer_id: string | null;
  state: RequestState;
  language: string;
  room_name: string;
  created_at: string;
  matched_at: string | null;
  ended_at: string | null;
};

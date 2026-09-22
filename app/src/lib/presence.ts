// 「今この瞬間、何人が待機しているか」
//
// これを依頼者に見せるのが地味に効く。0人だと分かっていれば
// 30秒待たされてから諦めるのではなく、最初から AI 読み上げを選べる。
import { supabase } from "./supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

let channel: RealtimeChannel | null = null;

/** ボランティアが待機に入る。画面を閉じると自動的に消える。 */
export async function goOnline(userId: string, language = "ja"): Promise<void> {
  await leave();

  channel = supabase.channel(`volunteers:${language}`, {
    config: { presence: { key: userId } },
  });

  await new Promise<void>((resolve) => {
    channel!.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel!.track({ online_at: new Date().toISOString() });
        resolve();
      }
    });
  });

  // アプリを閉じている間に鳴らすための恒久的な印。
  // Presence（揮発）と DB（永続）の二重管理だが、
  // 片方だけだと「開いている人にしか届かない」か
  // 「閉じた人にも鳴り続ける」のどちらかになる。
  await supabase
    .from("volunteer_status")
    .upsert({ user_id: userId, is_available: true, language, last_seen_at: new Date().toISOString() });
}

export async function goOffline(userId: string): Promise<void> {
  await leave();
  await supabase
    .from("volunteer_status")
    .upsert({ user_id: userId, is_available: false, last_seen_at: new Date().toISOString() });
}

async function leave() {
  if (channel) {
    await supabase.removeChannel(channel);
    channel = null;
  }
}

/** 依頼者側から見た待機人数。購読するだけで track はしない。 */
export function watchAvailableCount(
  language: string,
  onChange: (count: number) => void,
): { unsubscribe: () => void } {
  const observer = supabase.channel(`volunteers:${language}`, {
    config: { presence: { key: "" } },
  });

  const report = () => onChange(Object.keys(observer.presenceState()).length);

  observer
    .on("presence", { event: "sync" }, report)
    .on("presence", { event: "join" }, report)
    .on("presence", { event: "leave" }, report)
    .subscribe();

  return { unsubscribe: () => void supabase.removeChannel(observer) };
}

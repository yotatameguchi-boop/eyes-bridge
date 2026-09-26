// ボランティアの「鳴らさない時間帯」。サーバはこの時間帯の人を着信の段から外す
// （0013_ring_waves.sql の in_quiet_hours）。
import { supabase } from "./supabase";
import { presetOf, type QuietPreset } from "./quietPresets";

export { QUIET_PRESETS, type QuietPreset } from "./quietPresets";

export async function fetchQuietPreset(userId: string): Promise<QuietPreset | null> {
  const { data } = await supabase
    .from("volunteer_status")
    .select("quiet_start, quiet_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return presetOf(data.quiet_start as string | null, data.quiet_end as string | null);
}

export async function saveQuietPreset(userId: string, preset: QuietPreset): Promise<void> {
  const { error } = await supabase
    .from("volunteer_status")
    .update({ quiet_start: preset.start, quiet_end: preset.end })
    .eq("user_id", userId);
  if (error) throw error;
}

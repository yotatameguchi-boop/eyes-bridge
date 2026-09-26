// 「鳴らさない時間帯」の選択肢。DB に触らない部分だけをここに置く
// （テストを端末なしで node から直接読めるように）。
//
// 時刻を自由に入力させる形にはしない。時刻の選択はスクリーンリーダーでも
// 手でも操作が細かくなるので、よく使う時間帯から選ぶ形にした。

export type QuietPreset = { id: string; label: string; start: string | null; end: string | null };

export const QUIET_PRESETS: QuietPreset[] = [
  { id: "none", label: "設定しない（いつでも鳴らす）", start: null, end: null },
  { id: "22-7", label: "夜10時から朝7時", start: "22:00", end: "07:00" },
  { id: "23-7", label: "夜11時から朝7時", start: "23:00", end: "07:00" },
  { id: "0-6", label: "夜12時から朝6時", start: "00:00", end: "06:00" },
];

/** DB の値（"22:00:00" など）から、どの時間帯かを返す。当てはまらなければ null */
export function presetOf(start: string | null, end: string | null): QuietPreset | null {
  const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
  return QUIET_PRESETS.find((p) => p.start === hm(start) && p.end === hm(end)) ?? null;
}

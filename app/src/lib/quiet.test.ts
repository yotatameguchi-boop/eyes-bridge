import { test } from "node:test";
import assert from "node:assert/strict";
import { presetOf, QUIET_PRESETS } from "./quietPresets.ts";

test("DB の時刻（秒付き）から、どの時間帯かが分かる", () => {
  assert.equal(presetOf("22:00:00", "07:00:00")?.id, "22-7");
  assert.equal(presetOf("00:00:00", "06:00:00")?.id, "0-6");
});

test("設定していなければ「設定しない」", () => {
  assert.equal(presetOf(null, null)?.id, "none");
});

test("選択肢にない時刻なら null（勝手に別の時間帯として表示しない）", () => {
  assert.equal(presetOf("21:30:00", "05:00:00"), null);
});

test("選択肢の名前は、画面が見えなくても分かる言い方になっている", () => {
  for (const p of QUIET_PRESETS) assert.doesNotMatch(p.label, /\d{1,2}:\d{2}/, p.label);
});

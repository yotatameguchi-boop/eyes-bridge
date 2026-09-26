// 薬の注意のテスト。見逃し（薬なのに言わない）が一番危ないので、
// 実際の薬袋・説明書によくある書き方で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeMedicine } from "./cautions.ts";
import { composeReading, type FrameInfo, type FrameLine } from "./framing.ts";

test("薬袋・説明書によくある書き方は、薬の説明とみなす", () => {
  for (const text of [
    "用法・用量 1回1錠 1日3回 毎食後",
    "ロキソプロフェン錠60mg\n1日3回 食後に服用",
    "お薬手帳をお持ちください",
    "目薬 1日4回 両目に1滴ずつ",
    "頓服 痛い時に1包",
    "アモキシシリン 250mg 1日3回 8時間ごと",
    "１日２回 朝夕食後 2錠",
  ]) {
    assert.equal(looksLikeMedicine(text), true, text);
  }
});

test("薬と関係ない文は、薬の説明とみなさない（言い過ぎない）", () => {
  for (const text of [
    "薬味はお好みで",               // 「薬」を含むが薬ではない
    "本日のランチ 食後にコーヒー付き", // タイミングだけ
    "内容量 500ml",                  // 量だけ
    "東京都公安委員会 運転免許証",
    "合計 1,280円",
  ]) {
    assert.equal(looksLikeMedicine(text), false, text);
  }
});

const frame: FrameInfo = { blur: 500, brightness: 160, contrast: 60 };
const lines = (confidence: number): FrameLine[] => [
  { text: "x", confidence, box: [0.3, 0.3, 0.6, 0.34] },
];

test("薬の説明なら、本文より先に注意を読む（1つの読み上げの中で）", () => {
  const r = composeReading("1回1錠 1日3回 毎食後に服用", lines(0.95), frame);
  assert.equal(r.medicine, true);
  assert.match(r.spoken, /^お薬の説明のようです。.*薬剤師か家族にも確かめてください。1回1錠/);
});

test("薬の注意と、自信の無い部分の警告は、両方言う（注意が先）", () => {
  // 自信が低いので、先頭には撮り直しの案内が来る。その後に注意→警告→本文の順
  const r = composeReading("1回1錠 1日3回 毎食後に服用", lines(0.4), frame);
  assert.match(r.spoken, /読めたところを読みます。お薬の説明のようです。.*はっきり読めない部分があります。1回1錠/);
});

test("薬でなければ注意は付けない", () => {
  const r = composeReading("東京都公安委員会", lines(0.95), frame);
  assert.equal(r.medicine, false);
  assert.doesNotMatch(r.spoken, /お薬/);
});

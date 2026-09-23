// 撮影の案内のテスト。
//
// 前半は、実際の OCR サーバの出力（__fixtures__/framing_samples.json）を使う。
// 閾値を思い込みで決めると外れる（実際、最初の案は5か所外れていた）ので、
// 本物の検出結果に対して「その場面で何と言うか」を確かめる。
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessFrame,
  composeReading,
  type FrameInfo,
  type FrameLine,
} from "./framing.ts";

type Sample = { text: string; blocks: FrameLine[]; frame: FrameInfo & { rotated: number } };
const samples: Record<string, Sample> = JSON.parse(
  readFileSync(new URL("./__fixtures__/framing_samples.json", import.meta.url), "utf8"),
);

const assess = (name: string) => assessFrame(samples[name].blocks, samples[name].frame);
const reading = (name: string) =>
  composeReading(samples[name].text, samples[name].blocks, samples[name].frame);

// --------------------------------------------------------- 実データの場面

test("きちんと写っていれば、何も言わずに読む", () => {
  assert.deepEqual(assess("ok"), { kind: "ok" });
  const r = reading("ok");
  assert.equal(r.guidance, null);
  assert.equal(r.retake, false);
  assert.ok(r.spoken.startsWith("運転免許証"), r.spoken);
});

test("右側が画面からはみ出していたら、右へずらすよう言う", () => {
  assert.deepEqual(assess("cut_right"), { kind: "cut-off", sides: ["right"] });
  const r = reading("cut_right");
  assert.match(r.spoken, /^右側が切れています。スマホを少し右へずらすか/);
  assert.equal(r.retake, true);
});

test("横向きに撮った写真では、スマホを構えた向きで方向を言う（右ではなく上）", () => {
  // 同じ「右がはみ出した」紙を、スマホを反時計回りに倒して撮ったもの。
  // スマホから見ると、はみ出しているのは上側になる
  assert.equal(samples.cut_right_sideways.frame.rotated, 270);
  assert.deepEqual(assess("cut_right_sideways"), { kind: "cut-off", sides: ["top"] });
  assert.match(reading("cut_right_sideways").spoken, /^上側が切れています。スマホを少し上へ/);
});

test("下端のすぐ手前まで文字があれば、続きがあるかもしれないと言う（撮り直しは勧めない）", () => {
  // 横に切れた行は検出されないので、「切れている」証拠は無い。
  // 最後の行が端に近すぎることだけが手がかり
  assert.deepEqual(assess("cut_bottom"), { kind: "maybe-more", sides: ["bottom"] });
  const r = reading("cut_bottom");
  assert.match(r.spoken, /^下にも続きがあるかもしれません/);
  assert.equal(r.retake, false);
});

test("寄りすぎて文字が大きく、端に掛かっていたら「離して」と言う", () => {
  const g = assess("too_close");
  assert.equal(g.kind, "too-close");
  assert.match(reading("too_close").spoken, /^近すぎて/);
});

test("ひどくぼけて1行も読めなければ、ぼやけていると言う（「文字が無い」とは言わない）", () => {
  assert.deepEqual(assess("blurry"), { kind: "blurry" });
  const r = reading("blurry");
  assert.match(r.spoken, /^ぼやけていて読めません/);
  assert.equal(r.retake, true);
});

test("白紙なら、文字が見つからないと言う（ぼやけているとは言わない）", () => {
  assert.deepEqual(assess("blank"), { kind: "no-text" });
  assert.match(reading("blank").spoken, /^文字が見つかりませんでした。スマホを紙の真上に/);
});

test("暗くても読めていれば、撮り直させない", () => {
  assert.equal(samples.dark.frame.brightness < 50, true, "暗い写真であること");
  assert.deepEqual(assess("dark"), { kind: "ok" });
  assert.equal(reading("dark").retake, false);
});

test("文字が小さくても読めていれば、撮り直させない", () => {
  assert.deepEqual(assess("too_far"), { kind: "ok" });
  assert.equal(reading("too_far").retake, false);
});

// ------------------------------------------------ 実データに無い場面（組み立て）

const frame: FrameInfo = { blur: 500, brightness: 160, contrast: 60 };
const line = (box: [number, number, number, number], confidence = 0.95, text = "行"): FrameLine => ({
  text,
  confidence,
  box,
});

test("2辺が切れていたら、方向ではなく「離して」と言う", () => {
  // 右端で切れた行と、下端で切れた行（どちらも普通の太さの1行）
  const lines = [line([0.1, 0.3, 0.99, 0.34]), line([0.1, 0.96, 0.5, 0.995])];
  const g = assessFrame(lines, frame);
  assert.deepEqual(g, { kind: "cut-off", sides: ["right", "bottom"] });
  assert.match(composeReading("行\n行", lines, frame).spoken, /^右と下が切れています。スマホを少し離して/);
});

test("暗くて1行も読めなければ、暗いと言う", () => {
  assert.deepEqual(assessFrame([], { blur: 3, brightness: 20, contrast: 30 }), { kind: "too-dark" });
});

test("自信の無い読み取りで文字が小さければ、近づけるよう言う", () => {
  const lines = [line([0.4, 0.45, 0.6, 0.46], 0.3), line([0.4, 0.47, 0.6, 0.48], 0.4)];
  assert.deepEqual(assessFrame(lines, frame), { kind: "too-far" });
});

test("案内のあとに、読めたところを1つの読み上げで続けて読む", () => {
  const lines = [line([0.1, 0.3, 0.99, 0.34], 0.95, "お薬 1日3回")];
  const r = composeReading("お薬 1日3回", lines, frame);
  assert.match(r.spoken, /^右側が切れています。.*読めたところを読みます。お薬 1日3回$/);
});

test("自信の無い行があれば、本文の前に必ずそう言う（案内があってもなくても）", () => {
  const lines = [line([0.3, 0.3, 0.6, 0.34], 0.95, "合計"), line([0.3, 0.4, 0.6, 0.44], 0.4, "1,280円")];
  const r = composeReading("合計\n1,280円", lines, frame);
  assert.match(r.spoken, /はっきり読めない部分があります。合計/);
});

test("読めた文字が無いときは、案内だけを言う（空の本文を読まない）", () => {
  const r = composeReading("", [], { blur: 0, brightness: 230, contrast: 0 });
  assert.equal(r.spoken, r.guidance);
  assert.doesNotMatch(r.spoken, /読めたところを読みます/);
});

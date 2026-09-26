// 撮れた写真を見て、うまく写っていなければ「どう撮り直せばいいか」を決める。
//
// 目が見えない人は、紙が画面に入っているかを確かめられない。
// 「文字が見つかりませんでした」だけでは何を直せばいいか分からず、
// 当てずっぽうで撮り直すしかない。ここでは写り方から原因を1つに絞り、
// スマホをどちらに動かせばいいかまで言う。
//
// 方針（実際の OCR の出力で確かめて決めた）:
//   * 読めたのなら口を出さない。暗くても、文字が小さくても、読めていれば
//     撮り直させない。読めなかった・欠けた・自信が無い、ときだけ案内する
//   * 方向は「スマホを構えている向き」での上下左右。横向きに撮った写真でも
//     サーバ側で撮った向きに戻した座標を受け取っている
//
// React Native に依存しない。いまは撮った後に1回判断しているが、
// 将来、撮る前に案内するライブ方式にしたときも、端末内の文字検出の結果を
// 同じ形で渡せばこの関数をそのまま使える。

import { looksLikeMedicine, MEDICINE_CAUTION } from "./cautions.ts";

export type Box = [number, number, number, number]; // 0〜1 に正規化した x0, y0, x1, y1

export type FrameLine = { text: string; confidence: number; box: Box };

export type FrameInfo = {
  blur: number; // 小さいほどぼけている
  brightness: number; // 0〜255
  contrast: number; // 濃淡のばらつき。白紙なら 0 に近い
};

export type Side = "left" | "right" | "top" | "bottom";

export type Guidance =
  | { kind: "ok" }
  | { kind: "no-text" }
  | { kind: "too-dark" }
  | { kind: "blurry" }
  | { kind: "too-close"; sides: Side[] }
  | { kind: "cut-off"; sides: Side[] } // 画面の端が文字の途中を通っている
  | { kind: "maybe-more"; sides: Side[] } // 端のすぐ手前まで文字がある。続きがあるかもしれない
  | { kind: "too-far" }
  | { kind: "unclear" };

// 閾値。値の根拠は framing.test.ts の実データ（fixture）にある
export const THRESHOLDS = {
  /** 行の枠がこれより端に寄っていたら、端で切れているとみなす */
  edgeTouch: 0.02,
  /** 文字の並びと端の隙間が「行の太さ × これ」未満なら、続きがあるかもしれない */
  nearEdgeLines: 2,
  /** 行の太さの中央値（画面に対する割合）がこれを超えたら近すぎる */
  tooCloseThickness: 0.06,
  /** 行の太さの中央値がこれ未満で、しかも自信が無ければ遠すぎる */
  tooFarThickness: 0.015,
  /** 平均の自信がこれ未満なら「はっきり読めていない」 */
  lowConfidence: 0.6,
  /** 明るさがこれ未満なら暗い */
  dark: 50,
  /** ぼけの値がこれ未満ならぼけている */
  blurry: 30,
  /** 濃淡のばらつきがこれ以上なら、何かは写っている（白紙ではない） */
  somethingThere: 15,
} as const;

const SIDES: Side[] = ["left", "right", "top", "bottom"];

/** 行の太さ = 枠の短い辺。横向きに撮ると行は縦長の枠になるので、高さでは測れない */
function thickness([x0, y0, x1, y1]: Box): number {
  return Math.min(x1 - x0, y1 - y0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function touches(box: Box, side: Side): boolean {
  const t = THRESHOLDS.edgeTouch;
  switch (side) {
    case "left":
      return box[0] < t;
    case "right":
      return box[2] > 1 - t;
    case "top":
      return box[1] < t;
    case "bottom":
      return box[3] > 1 - t;
  }
}

/** 文字の並び全体と、各辺との隙間 */
function gaps(lines: FrameLine[]): Record<Side, number> {
  const x0 = Math.min(...lines.map((l) => l.box[0]));
  const y0 = Math.min(...lines.map((l) => l.box[1]));
  const x1 = Math.max(...lines.map((l) => l.box[2]));
  const y1 = Math.max(...lines.map((l) => l.box[3]));
  return { left: x0, right: 1 - x1, top: y0, bottom: 1 - y1 };
}

export function assessFrame(lines: FrameLine[], frame: FrameInfo): Guidance {
  const T = THRESHOLDS;

  // --- 1行も読めなかった ---
  if (lines.length === 0) {
    if (frame.brightness < T.dark) return { kind: "too-dark" };
    // 何かは写っているのに文字が無い＋ぼけている → ピンぼけ・手ぶれ。
    // 白紙もぼけの値はほぼ 0 になるので、濃淡のばらつきで分ける
    if (frame.contrast >= T.somethingThere && frame.blur < T.blurry) return { kind: "blurry" };
    return { kind: "no-text" };
  }

  const lineThickness = median(lines.map((l) => thickness(l.box)));

  // --- 端で切れている ---
  const cut = SIDES.filter((side) => lines.some((l) => touches(l.box, side)));
  const gap = gaps(lines);
  const near = SIDES.filter(
    (side) => !cut.includes(side) && gap[side] < lineThickness * T.nearEdgeLines,
  );

  if (cut.length > 0 || near.length > 0) {
    // 文字が大きく写っていて端に掛かっている → 寄りすぎ。離せば全部入る
    if (lineThickness > T.tooCloseThickness) return { kind: "too-close", sides: [...cut, ...near] };
    if (cut.length > 0) return { kind: "cut-off", sides: cut };
    return { kind: "maybe-more", sides: near };
  }

  // --- 読めたが、自信が無い ---
  const meanConfidence = lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length;
  if (meanConfidence < T.lowConfidence) {
    if (frame.brightness < T.dark) return { kind: "too-dark" };
    if (lineThickness < T.tooFarThickness) return { kind: "too-far" };
    if (frame.blur < T.blurry) return { kind: "blurry" };
    return { kind: "unclear" };
  }

  return { kind: "ok" };
}

// ------------------------------------------------------------ 何と言うか

const SIDE_NAME: Record<Side, string> = { left: "左", right: "右", top: "上", bottom: "下" };

function sidesPhrase(sides: Side[]): string {
  return sides.map((s) => SIDE_NAME[s]).join("と");
}

export type Reading = {
  /** 読み上げる内容（案内・注意・本文を1つにまとめたもの） */
  spoken: string;
  /** 薬の説明らしいか（画面にも注意を出す） */
  medicine: boolean;
  /** 画面に出す案内。案内が無ければ null */
  guidance: string | null;
  /** 撮り直しを勧めるか（撮るボタンの名前を「撮り直す」にする） */
  retake: boolean;
};

const HOLD_TIP = "スマホを紙の真上に、30センチほど離して構えてください。";
const LOW_CONFIDENCE_NOTICE = "はっきり読めない部分があります。";

/** 案内の文。スマホを「どちらに動かすか」まで言う */
export function guidanceText(g: Guidance): string | null {
  switch (g.kind) {
    case "ok":
      return null;
    case "no-text":
      return `文字が見つかりませんでした。${HOLD_TIP}もう一度撮ってください。`;
    case "too-dark":
      return "暗くて読めません。明るい場所で、もう一度撮ってください。";
    case "blurry":
      return "ぼやけていて読めません。スマホを両手で持ち、動かさないようにして撮り直してください。";
    case "too-close":
      return "近すぎて、紙がはみ出しています。スマホを少し離して撮り直してください。";
    case "cut-off":
      // 1辺なら動かす方向を言う。2辺以上なら「離す」のほうが確実
      return g.sides.length === 1
        ? `${SIDE_NAME[g.sides[0]]}側が切れています。スマホを少し${SIDE_NAME[g.sides[0]]}へずらすか、少し離して撮り直すと、続きも読めます。`
        : `${sidesPhrase(g.sides)}が切れています。スマホを少し離して撮り直すと、続きも読めます。`;
    case "maybe-more":
      return `${sidesPhrase(g.sides)}にも続きがあるかもしれません。気になるときは、スマホを少し離して撮り直してください。`;
    case "too-far":
      return "文字が小さく写っています。スマホをもう少し近づけて撮り直してください。";
    case "unclear":
      return `はっきり読めませんでした。${HOLD_TIP}明るい場所で撮り直してください。`;
  }
}

/**
 * 案内と本文を「1つの読み上げ」にまとめる。
 * 別々に出すと、後の読み上げが前のものを切ってしまうため（speaker.ts 参照）。
 * 読めた文字があれば、案内のあとに必ず読む。撮り直すかは本人が決める。
 */
export function composeReading(
  text: string,
  lines: FrameLine[],
  frame: FrameInfo,
): Reading {
  const g = assessFrame(lines, frame);
  const guidance = guidanceText(g);
  const hasText = text.trim().length > 0;
  const lowConfidence = hasText && lines.some((l) => l.confidence < THRESHOLDS.lowConfidence);

  if (!hasText) {
    return { spoken: guidance ?? "", guidance, retake: true, medicine: false };
  }

  // 薬の説明なら、本文より先に「人にも確かめて」と言う。
  // 自信の低い行への警告だけでは、自信満々の読み間違いを防げないため。
  const medicine = looksLikeMedicine(text);
  const body = `${medicine ? MEDICINE_CAUTION : ""}${lowConfidence ? LOW_CONFIDENCE_NOTICE : ""}${text}`;
  if (!guidance) {
    return { spoken: body, guidance: null, retake: false, medicine };
  }

  // 「続きがあるかもしれない」は推測なので、撮り直しまでは勧めない
  const retake = g.kind !== "maybe-more";
  return { spoken: `${guidance}読めたところを読みます。${body}`, guidance, retake, medicine };
}

// 画面を見ない人に、状態の変化をどう伝えるか。
//
// 視覚UIだと「繋がりました」は色と文字で分かるが、
// スクリーンリーダー利用者には何も起きていないのと同じになる。
// 状態が変わる場所では必ず「声」と「振動」の両方を出す。
// 声だけだと騒がしい場所で落ち、振動だけだと理由が分からないため。
//
// 声は「1回だけ」出す。スクリーンリーダーを使っている人にはその声で、
// 使っていない人にはアプリの声で。振り分けは speaker.ts（テスト付き）。
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { createSpeaker } from "./speaker";

const speaker = createSpeaker({
  isScreenReaderEnabled: () => AccessibilityInfo.isScreenReaderEnabled(),
  onScreenReaderChanged: (listener) => {
    AccessibilityInfo.addEventListener("screenReaderChanged", listener);
  },
  announce: (message) => {
    if (Platform.OS === "ios") {
      // ボタンを押した直後は VoiceOver がボタン名を読んでいる。
      // 割り込ませると知らせのほうが消えることがあるので、後ろに並べる。
      AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    } else {
      AccessibilityInfo.announceForAccessibility(message);
    }
  },
  speak: (message, rate) => {
    Speech.speak(message, { language: "ja-JP", rate, pitch: 1.0 });
  },
  stopSpeaking: () => {
    void Speech.stop();
  },
});

/** 短い知らせを1回だけ伝える（声のみ。振動が要るなら notifyStateChange）。 */
export const say = speaker.say;

/**
 * 長い文章を読む。スクリーンリーダー使用中は focus() でその文章の要素に
 * フォーカスを移し、利用者の声と速さで読ませる。未使用ならアプリが読む。
 */
export const readLongText = speaker.readLong;

export const stopSpeaking = speaker.stop;
export const usingScreenReader = speaker.usingScreenReader;

/** 画面の出し分け用。スクリーンリーダーの切り替えにも追従する。 */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void usingScreenReader().then((value) => {
      if (alive) setOn(value);
    });
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return on;
}

export const feedback = {
  /** 依頼を出した、受けたなど「前に進んだ」瞬間 */
  progress: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  /** 繋がった */
  connected: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  /** 誰も取らなかった、切れた */
  failed: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
};

/** 状態変化を、振動と声（1回だけ）で伝える。 */
export async function notifyStateChange(
  message: string,
  kind: keyof typeof feedback = "progress",
) {
  await feedback[kind]().catch(() => {});
  await say(message);
}

/** iOS は VoiceOver、Android は TalkBack。文言を出し分けるときに使う。 */
export const screenReaderName = Platform.OS === "ios" ? "VoiceOver" : "TalkBack";

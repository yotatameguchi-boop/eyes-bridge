// 画面を見ない人に、状態の変化をどう伝えるか。
//
// 視覚UIだと「繋がりました」は色と文字で分かるが、
// スクリーンリーダー利用者には何も起きていないのと同じになる。
// 状態が変わる場所では必ず「読み上げ」と「振動」の両方を出す。
// 音だけだと騒がしい場所で落ち、振動だけだと理由が分からないため。
import { AccessibilityInfo, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";

/** スクリーンリーダーに割り込んで読ませる。 */
export function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

/**
 * スクリーンリーダーを使っていない弱視の人にも届くよう、
 * 実際に喋る。announce はリーダー未使用だと無音のため。
 */
export async function speak(message: string, opts?: { interrupt?: boolean }) {
  if (opts?.interrupt !== false) Speech.stop();
  Speech.speak(message, { language: "ja-JP", rate: 1.0, pitch: 1.0 });
}

export function stopSpeaking() {
  Speech.stop();
}

export const feedback = {
  /** 依頼を出した、受けたなど「前に進んだ」瞬間 */
  progress: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  /** 繋がった */
  connected: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  /** 誰も取らなかった、切れた */
  failed: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
};

/** 状態変化を三重（読み上げ・発話・振動）で伝える。 */
export async function notifyStateChange(
  message: string,
  kind: keyof typeof feedback = "progress",
) {
  await feedback[kind]().catch(() => {});
  announce(message);
  await speak(message);
}

export async function isScreenReaderOn(): Promise<boolean> {
  return AccessibilityInfo.isScreenReaderEnabled();
}

/** iOS は VoiceOver、Android は TalkBack。文言を出し分けるときに使う。 */
export const screenReaderName = Platform.OS === "ios" ? "VoiceOver" : "TalkBack";

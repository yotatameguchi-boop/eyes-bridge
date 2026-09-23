// 1つの知らせを、利用者の聞き方に合わせて「1回だけ」伝える。
//
// 以前は状態が変わるたびに、スクリーンリーダーへの読み上げ依頼と
// アプリ自身の声の両方を出していた。スクリーンリーダー（VoiceOver /
// TalkBack）を使っている人には、同じ文が2つの声で重なって聞こえていた。
// 目が見えない人の多くはスクリーンリーダーを使うので、全操作に響く不具合だった。
//
//   スクリーンリーダーを使っている → その人の声と速さで読ませる。アプリは喋らない
//   使っていない（弱視・晴眼）     → アプリが自分の声で喋る
//
// React Native に依存しない形にしてあるのは、この振り分けを
// 端末なしで試せるようにするため（speaker.test.ts）。

export type SpeakerDeps = {
  isScreenReaderEnabled: () => Promise<boolean>;
  onScreenReaderChanged: (listener: (enabled: boolean) => void) => void;
  /** スクリーンリーダーに読ませる */
  announce: (message: string) => void;
  /** アプリ自身の声で読む（rate は 1.0 が標準） */
  speak: (message: string, rate: number) => void;
  stopSpeaking: () => void;
};

export type Channel = "screen-reader" | "app-voice";

export type Speaker = {
  usingScreenReader: () => Promise<boolean>;
  /** 短い知らせ（「繋がりました」など） */
  say: (message: string) => Promise<Channel>;
  /**
   * 長い文章（読み取り結果）。スクリーンリーダー使用中は、読み上げ依頼では
   * なくその文章の要素にフォーカスを移して読ませる。読み上げ依頼だと
   * 途中で次の操作に割り込まれて切れ、聞き直すこともできないため。
   * フォーカスなら、利用者は自分の操作で何度でも聞き直せる。
   */
  readLong: (text: string, focus: () => void) => Promise<Channel>;
  stop: () => void;
};

export function createSpeaker(deps: SpeakerDeps): Speaker {
  let enabled = false;
  let known = false;

  // 起動直後の最初の知らせが、判定の終わる前に出ることがある。
  // その間は「使っていない」とみなすと、VoiceOver 利用者に1回だけ
  // 二重に聞こえてしまうので、判定を待ってから振り分ける。
  const ready = deps.isScreenReaderEnabled().then(
    (value) => {
      // 判定の最中に切り替えがあったら、そちらが新しい
      if (!known) enabled = value;
      known = true;
    },
    () => {
      known = true;
    },
  );

  deps.onScreenReaderChanged((value) => {
    enabled = value;
    known = true;
    // アプリの声が流れている最中に VoiceOver を点けると、
    // 残りがスクリーンリーダーの声と重なる。その場で止める。
    if (value) deps.stopSpeaking();
  });

  async function usingScreenReader(): Promise<boolean> {
    await ready;
    return enabled;
  }

  return {
    usingScreenReader,

    async say(message) {
      if (await usingScreenReader()) {
        deps.announce(message);
        return "screen-reader";
      }
      deps.stopSpeaking();
      deps.speak(message, 1.0);
      return "app-voice";
    },

    async readLong(text, focus) {
      if (await usingScreenReader()) {
        focus();
        return "screen-reader";
      }
      deps.stopSpeaking();
      deps.speak(text, 0.95);
      return "app-voice";
    },

    stop() {
      deps.stopSpeaking();
    },
  };
}

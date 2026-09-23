import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { AccessibilityInfo, ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { BigButton } from "../components/BigButton";
import { ocrAvailable, readImage } from "../lib/ocr";
import { composeReading, THRESHOLDS, type Reading } from "../lib/framing";
import {
  feedback,
  notifyStateChange,
  readLongText,
  say,
  stopSpeaking,
  useScreenReader,
} from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

export function ReadAloudScreen({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const screenReader = useScreenReader();
  const resultRef = useRef<ComponentRef<typeof Text>>(null);

  // 撮り方の案内・自信の無い部分の警告・本文は、composeReading が
  // 「1つの読み上げ」にまとめてある。別々に出すと後のものが前を切るため。
  const spoken = reading?.spoken ?? "";

  const focusResult = useCallback(() => {
    // 描画が落ち着く前にフォーカスを送ると、iOS では無視されることがある
    setTimeout(() => {
      if (resultRef.current) AccessibilityInfo.sendAccessibilityEvent(resultRef.current, "focus");
    }, 300);
  }, []);

  // 結果が出たら1回だけ読む。
  useEffect(() => {
    if (spoken) void readLongText(spoken, focusResult);
  }, [spoken, focusResult]);

  // 途中で戻ったとき、アプリの声が次の画面の知らせに重ならないように止める
  useEffect(() => () => stopSpeaking(), []);

  async function capture() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      await notifyStateChange("カメラを使う許可が必要です", "failed");
      return;
    }

    const shot = await ImagePicker.launchCameraAsync({ quality: 0.9, exif: false });
    if (shot.canceled) return;

    setBusy(true);
    setText(null);
    setReading(null);
    await say("読み取っています");

    try {
      const result = await readImage(shot.assets[0].uri);
      const next = composeReading(result.text, result.blocks, result.frame);

      // 撮り直したほうがいいときは、声より先に振動で「うまくいかなかった」を伝える
      await (next.retake ? feedback.failed() : feedback.progress()).catch(() => {});

      // 読み上げは上の useEffect が1回だけ行う
      setLowConfidence(result.blocks.some((b) => b.confidence < THRESHOLDS.lowConfidence));
      setText(result.text);
      setReading(next);
    } catch {
      await notifyStateChange("読み取れませんでした。通信を確かめて、もう一度撮ってください", "failed");
    } finally {
      setBusy(false);
    }
  }

  function repeat() {
    if (spoken) void readLongText(spoken, focusResult);
  }

  if (!ocrAvailable) {
    return (
      <View style={styles.root}>
        <Text style={styles.message}>
          読み上げサーバが設定されていません。EXPO_PUBLIC_OCR_URL を設定してください。
        </Text>
        <BigButton label="戻る" variant="secondary" onPress={onBack} />
      </View>
    );
  }

  const hasText = !!text && text.trim().length > 0;

  return (
    <View style={styles.root}>
      <BigButton
        label={busy ? "読み取り中" : reading?.retake ? "撮り直す" : "写して読ませる"}
        // 「画面いっぱいに入れて」とは言わない。画面が見えない人には確かめようがない。
        // 構え方を具体的に伝え、うまく写らなかったら撮った後に直し方を言う。
        hint="カメラが開きます。スマホを紙の真上に、30センチほど離して構えてから撮ってください。うまく写っていなければ、撮ったあとに直し方をお伝えします"
        onPress={capture}
        disabled={busy}
        hero
      />

      {busy ? <ActivityIndicator size="large" color={colors.primary} style={{ margin: space.md }} /> : null}

      {reading ? (
        <View style={styles.result}>
          {/* 以下2つは目で見る人向けの表示。どちらも本文の読み上げの先頭に
              入れてあるので、スクリーンリーダーからは隠す（なぞったとき2回聞こえないように）。
              文字が無いときは案内そのものを下の本文の場所に出すので、ここには出さない。 */}
          {reading.guidance && hasText ? (
            <Text
              style={styles.guidance}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {reading.guidance}
            </Text>
          ) : null}
          {lowConfidence && hasText ? (
            <Text
              style={styles.warning}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              はっきり読めない部分があります。
            </Text>
          ) : null}
          <ScrollView>
            {/* live region にしない。結果は useEffect で1回だけ読む。
                live region だと Android では TalkBack とアプリの声が同時に読む。 */}
            <Text ref={resultRef} style={styles.resultText} accessibilityLabel={spoken}>
              {hasText ? text : reading.guidance}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      <View style={{ height: space.sm }} />
      {spoken ? (
        <>
          <BigButton label="もう一度読み上げる" variant="secondary" onPress={repeat} />
          <View style={{ height: space.sm }} />
          {/* スクリーンリーダー使用中はアプリは喋っていないので、止めるものが無い。
              読み上げの停止はスクリーンリーダー自身の操作（2本指タップ）で行える。 */}
          {!screenReader ? (
            <>
              <BigButton label="読み上げを止める" variant="secondary" onPress={stopSpeaking} />
              <View style={{ height: space.sm }} />
            </>
          ) : null}
        </>
      ) : null}
      <BigButton label="戻る" variant="secondary" onPress={onBack} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.md },
  message: { color: colors.text, fontSize: typeScale.body, lineHeight: 32, marginBottom: space.md },
  result: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    flex: 1,
    marginVertical: space.md,
    padding: space.md,
  },
  resultText: { color: colors.text, fontSize: typeScale.body, lineHeight: 34 },
  guidance: {
    color: colors.primary,
    fontSize: typeScale.caption,
    fontWeight: "700",
    lineHeight: 28,
    marginBottom: space.sm,
  },
  warning: { color: colors.danger, fontSize: typeScale.caption, marginBottom: space.sm },
});

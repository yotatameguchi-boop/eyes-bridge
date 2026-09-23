import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { AccessibilityInfo, ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { BigButton } from "../components/BigButton";
import { ocrAvailable, readImage } from "../lib/ocr";
import {
  notifyStateChange,
  readLongText,
  say,
  stopSpeaking,
  useScreenReader,
} from "../lib/a11y";

const LOW_CONFIDENCE_NOTICE = "はっきり読めない部分があります。";
import { colors, space, type as typeScale } from "../theme";

export function ReadAloudScreen({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const screenReader = useScreenReader();
  const resultRef = useRef<ComponentRef<typeof Text>>(null);

  // 警告と本文は「1つの読み上げ」にまとめる。
  // 別々に出すと、アプリの声では本文が警告を止めて上書きし、
  // スクリーンリーダーではフォーカス移動が警告の読み上げを切る。
  // 黙って間違った金額や用量を読むのが一番まずいので、警告は必ず先に聞かせる。
  const spoken = text ? `${lowConfidence ? LOW_CONFIDENCE_NOTICE : ""}${text}` : "";

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
    await say("読み取っています");

    try {
      const result = await readImage(shot.assets[0].uri);

      if (result.text.trim().length === 0) {
        setText("");
        await notifyStateChange("文字が見つかりませんでした。もう一度撮ってください", "failed");
        return;
      }

      // 読み上げは上の useEffect が1回だけ行う
      setLowConfidence(result.blocks.some((b) => b.confidence < 0.6));
      setText(result.text);
    } catch {
      await notifyStateChange("読み取れませんでした", "failed");
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

  return (
    <View style={styles.root}>
      <BigButton
        label={busy ? "読み取り中" : "写して読ませる"}
        hint="カメラが開きます。読みたい紙を画面いっぱいに入れて撮ってください"
        onPress={capture}
        disabled={busy}
        hero
      />

      {busy ? <ActivityIndicator size="large" color={colors.primary} style={{ margin: space.md }} /> : null}

      {text !== null ? (
        <View style={styles.result}>
          {lowConfidence ? (
            // 目で見る人向けの表示。同じ警告は本文の読み上げの先頭に入れてあるので、
            // スクリーンリーダーからは隠す（なぞったときに2回聞こえないように）。
            <Text
              style={styles.warning}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {LOW_CONFIDENCE_NOTICE}
            </Text>
          ) : null}
          <ScrollView>
            {/* live region にしない。結果は useEffect で1回だけ読む。
                live region だと Android では TalkBack とアプリの声が同時に読む。 */}
            <Text
              ref={resultRef}
              style={styles.resultText}
              accessibilityLabel={spoken || "文字が見つかりませんでした"}
            >
              {text.length > 0 ? text : "文字が見つかりませんでした"}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      <View style={{ height: space.sm }} />
      {text ? (
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
  warning: { color: colors.danger, fontSize: typeScale.caption, marginBottom: space.sm },
});

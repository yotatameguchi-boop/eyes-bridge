import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Speech from "expo-speech";
import { BigButton } from "../components/BigButton";
import { ocrAvailable, readImage } from "../lib/ocr";
import { notifyStateChange, speak, stopSpeaking } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

export function ReadAloudScreen({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);

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
    await speak("読み取っています");

    try {
      const result = await readImage(shot.assets[0].uri);

      if (result.text.trim().length === 0) {
        setText("");
        await notifyStateChange("文字が見つかりませんでした。もう一度撮ってください", "failed");
        return;
      }

      // 自信の無い行があることは必ず伝える。
      // 黙って間違った金額を読み上げるのが一番まずい。
      const weak = result.blocks.some((b) => b.confidence < 0.6);
      setLowConfidence(weak);
      setText(result.text);

      if (weak) await speak("はっきり読めない部分があります。読み上げます");
      Speech.speak(result.text, { language: "ja-JP", rate: 0.95 });
    } catch {
      await notifyStateChange("読み取れませんでした", "failed");
    } finally {
      setBusy(false);
    }
  }

  function repeat() {
    if (text) {
      stopSpeaking();
      Speech.speak(text, { language: "ja-JP", rate: 0.9 });
    }
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
            <Text style={styles.warning} role="alert">
              はっきり読めない部分があります
            </Text>
          ) : null}
          <ScrollView>
            <Text style={styles.resultText} accessibilityLiveRegion="polite">
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
          <BigButton label="読み上げを止める" variant="secondary" onPress={stopSpeaking} />
          <View style={{ height: space.sm }} />
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

import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { notifyStateChange } from "../lib/a11y";
import { deleteAccount } from "../lib/session";
import { colors, space, type as typeScale } from "../theme";

// 退会の画面。取り消せないので、何が消えて何が残るかを先に読んでもらう。
// ボタンの名前にも「データを削除する」と、押すと何が起きるかまで入れる。
export function DeleteAccountScreen({ onCancel }: { onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // 消し終わるとログアウトし、アプリはログインの画面に戻る
      await notifyStateChange("退会しています");
      await deleteAccount();
    } catch {
      const text = "退会できませんでした。通信を確認して、もう一度お試しください。";
      setError(text);
      await notifyStateChange(text, "failed");
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        退会
      </Text>

      <Text style={styles.subhead} accessibilityRole="header">
        消えるもの
      </Text>
      <Text style={styles.body}>
        ・アカウントと、登録した役割{"\n"}
        ・依頼の記録、通報、ブロック{"\n"}
        ・同意の記録{"\n"}
        ・本人確認の書類の画像
      </Text>

      <Text style={styles.subhead} accessibilityRole="header">
        残るもの
      </Text>
      <Text style={styles.body}>
        不正な作り直しを防ぐため、本人確認の書類から作った元に戻せない識別子と、
        利用が止められていたかどうかだけを残します。これだけでは、あなたが誰かは分かりません。
      </Text>

      <Text style={styles.warning}>退会は取り消せません。</Text>

      {error ? (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      ) : null}

      <View style={{ height: space.md }} />
      <BigButton
        label={busy ? "退会しています" : "退会して、データを削除する"}
        variant="danger"
        onPress={confirm}
        disabled={busy}
      />
      <View style={{ height: space.sm }} />
      <BigButton label="退会しないで戻る" variant="secondary" onPress={onCancel} disabled={busy} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.md },
  subhead: { color: colors.text, fontSize: typeScale.body, fontWeight: "700", marginTop: space.md, marginBottom: space.xs },
  body: { color: colors.textMuted, fontSize: typeScale.caption, lineHeight: 30 },
  warning: { color: colors.danger, fontSize: typeScale.body, fontWeight: "700", marginTop: space.lg },
  error: { color: colors.danger, fontSize: typeScale.body, marginTop: space.md },
});

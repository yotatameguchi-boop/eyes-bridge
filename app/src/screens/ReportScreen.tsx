import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { REPORT_REASONS, reportParticipant, type ReportReason } from "../lib/safety";
import { notifyStateChange } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

// 通話が終わった直後にしか出さない。
// 設定の奥に通報を置くと、嫌な思いをした人ほど辿り着けない。
export function ReportScreen({
  requestId,
  onDone,
}: {
  requestId: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      // 通報した相手とは必ずブロックまでやる。
      // 「通報したのにまた同じ人が出てきた」が起きると二度と使われない。
      await reportParticipant(requestId, reason, detail, true);
      await notifyStateChange("通報しました。この相手とは今後繋がりません");
      onDone();
    } catch {
      await notifyStateChange("通報を送れませんでした", "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        通話について
      </Text>

      {!reason ? (
        <>
          <Text style={styles.lead}>問題がなければ、そのまま閉じてください。</Text>
          <BigButton label="問題なかった" onPress={onDone} />
          <View style={{ height: space.lg }} />
          <Text style={styles.subhead} accessibilityRole="header">
            通報する
          </Text>
          {REPORT_REASONS.map((r) => (
            <View key={r.value} style={{ marginBottom: space.sm }}>
              <BigButton
                label={r.label}
                variant="secondary"
                hint="選ぶと通報の確認画面に進みます"
                onPress={() => setReason(r.value)}
              />
            </View>
          ))}
        </>
      ) : (
        <>
          <Text style={styles.lead}>
            {REPORT_REASONS.find((r) => r.value === reason)?.label}
          </Text>
          <Text style={styles.label} nativeID="detailLabel">
            詳しく（任意）
          </Text>
          <TextInput
            style={styles.input}
            value={detail}
            onChangeText={setDetail}
            multiline
            maxLength={1000}
            accessibilityLabel="通報の詳細"
            accessibilityLabelledBy="detailLabel"
            placeholder="何があったか"
            placeholderTextColor={colors.textMuted}
          />
          <Text style={styles.note}>
            通報すると、この相手とは今後繋がらなくなります。
          </Text>
          <View style={{ height: space.md }} />
          <BigButton
            label={busy ? "送信中" : "通報する"}
            variant="danger"
            onPress={submit}
            disabled={busy}
          />
          <View style={{ height: space.sm }} />
          <BigButton label="やめる" variant="secondary" onPress={() => setReason(null)} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.sm },
  subhead: { color: colors.text, fontSize: typeScale.body, fontWeight: "700", marginBottom: space.sm },
  lead: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 32, marginBottom: space.md },
  label: { color: colors.text, fontSize: typeScale.caption, marginBottom: space.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 2,
    borderRadius: 12,
    color: colors.text,
    fontSize: typeScale.caption,
    minHeight: 120,
    padding: space.md,
    textAlignVertical: "top",
  },
  note: { color: colors.danger, fontSize: typeScale.caption, lineHeight: 26, marginTop: space.sm },
});

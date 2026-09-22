import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { chooseRole, type Profile, type Role } from "../lib/session";
import { notifyStateChange } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

export function RoleSelectScreen({ onDone }: { onDone: (profile: Profile) => void }) {
  const [busy, setBusy] = useState(false);

  async function pick(role: Role) {
    setBusy(true);
    try {
      const profile = await chooseRole(role);
      await notifyStateChange(
        role === "requester" ? "読んでもらう側で始めます" : "読む側で始めます",
      );
      onDone(profile);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        どちらで使いますか
      </Text>
      <Text style={styles.lead}>あとから変えられます。</Text>

      <BigButton
        label="読んでもらう"
        hint="カメラを向けて、ボランティアに読んでもらいます"
        onPress={() => pick("requester")}
        disabled={busy}
      />
      <View style={{ height: space.md }} />
      <BigButton
        label="読んであげる"
        hint="依頼が来たときに通知を受け取り、読み上げます"
        variant="secondary"
        onPress={() => pick("volunteer")}
        disabled={busy}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md, justifyContent: "center" },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.sm },
  lead: { color: colors.textMuted, fontSize: typeScale.body, marginBottom: space.lg },
});

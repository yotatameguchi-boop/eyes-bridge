import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import type { Role } from "../lib/session";
import { colors, space, type as typeScale } from "../theme";

// ここでは役割を保存しない。選んだだけで「依頼者＝見えにくさがある」ことを
// 記録すると、同意の前に要配慮個人情報を取得したことになる。
// 保存は次の同意の画面（ConsentScreen）で、同意と一緒に行う。
export function RoleSelectScreen({ onPick }: { onPick: (role: Role) => void }) {
  const pick = (role: Role) => onPick(role);

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
      />
      <View style={{ height: space.md }} />
      <BigButton
        label="読んであげる"
        hint="依頼が来たときに通知を受け取り、読み上げます"
        variant="secondary"
        onPress={() => pick("volunteer")}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md, justifyContent: "center" },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.sm },
  lead: { color: colors.textMuted, fontSize: typeScale.body, marginBottom: space.lg },
});

import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { IdentitySubmitScreen } from "./IdentitySubmitScreen";
import { agreeToTerms, type VolunteerStanding } from "../lib/safety";
import { notifyStateChange } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

// 審査を通るまでは待機画面に入れない。
// 「登録したのに何も起きない」と黙って放置されるのが一番離脱するので、
// 今どの段階にいて次に何が起きるかを必ず書く。
// 待機できるまでの関門は3つ。順番を入れ替えない。
//   1. 規約に同意する
//   2. 本人確認を出す
//   3. 運営が承認する
// 本人確認を先に求めると、何のために書類を出すのか分からないまま
// 免許証を撮らせることになる。先に守ってほしいことを読ませる。
export function VolunteerGateScreen({
  userId,
  standing,
  onRefresh,
}: {
  userId: string;
  standing: VolunteerStanding;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function agree() {
    setBusy(true);
    try {
      await agreeToTerms();
      await notifyStateChange("同意しました。審査の結果をお待ちください");
      onRefresh();
    } catch {
      await notifyStateChange("同意を記録できませんでした", "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!standing.agreedToTerms) {
    return (
      <ScrollView contentContainerStyle={styles.root}>
        <Text style={styles.title} accessibilityRole="header">
          守ってほしいこと
        </Text>

        <Rule text="映っているものを、その通話の外に持ち出さない。撮影も録音もしない。" />
        <Rule text="頼まれたものだけを読む。映り込んだ他のものを詮索しない。" />
        <Rule text="読み上げに自分の意見を混ぜない。書いてある通りに読む。" />
        <Rule text="相手の名前・住所・連絡先を覚えようとしない。" />
        <Rule text="通話の外で相手に連絡を取らない。" />
        <Rule text="命に関わる状況だと感じたら（火事・ガス・急な体調の変化など）、すぐに119に電話するよう相手に伝える。自分で解決しようとしない。" />
        <Rule text="お薬の量や回数を読むときは、数字を一つずつはっきり読む。飲むかどうかの判断や助言はしない（医師・薬剤師に聞くよう伝える）。" />

        <Text style={styles.note}>
          違反の通報が別々の人から3件集まると、自動で待機できなくなります。
        </Text>

        <View style={{ height: space.md }} />
        <BigButton
          label={busy ? "記録中" : "同意する"}
          hint="同意すると審査に進みます"
          onPress={agree}
          disabled={busy}
        />
      </ScrollView>
    );
  }

  if (standing.identityState === null || standing.identityState === "rejected") {
    return (
      <IdentitySubmitScreen
        userId={userId}
        rejectReason={
          standing.identityState === "rejected" ? standing.identityRejectReason : undefined
        }
        onSubmitted={onRefresh}
      />
    );
  }

  const message = {
    pending: {
      title: "審査待ちです",
      body: "本人確認の書類を運営が確認しています。承認されるとこの画面が待機画面に変わります。",
    },
    approved: { title: "承認されています", body: "画面を更新してください。" },
    suspended: {
      title: "待機を停止しています",
      body: "通報が重なったため停止中です。心当たりがない場合は運営に連絡してください。",
    },
    rejected: {
      title: "承認されませんでした",
      body: "今回は待機できません。",
    },
  }[standing.reviewState];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        {message.title}
      </Text>
      <Text style={styles.body} accessibilityLiveRegion="polite">
        {message.body}
      </Text>
      <View style={{ height: space.md }} />
      <BigButton label="状態を確認しなおす" variant="secondary" onPress={onRefresh} />
    </ScrollView>
  );
}

function Rule({ text }: { text: string }) {
  return (
    <View style={styles.rule} accessible accessibilityRole="text">
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.md },
  body: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 34 },
  rule: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    marginBottom: space.sm,
    padding: space.md,
  },
  ruleText: { color: colors.text, fontSize: typeScale.caption, lineHeight: 30 },
  note: { color: colors.danger, fontSize: typeScale.caption, lineHeight: 28, marginTop: space.md },
});

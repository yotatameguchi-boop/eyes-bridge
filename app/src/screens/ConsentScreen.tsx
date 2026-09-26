import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { documentsFor, type LegalDocument } from "../legal/documents";
import { notifyStateChange } from "../lib/a11y";
import { reconsent, registerRole, type Profile, type Role } from "../lib/session";
import { colors, space, type as typeScale } from "../theme";

// 同意の画面。
//
// 依頼者として登録することは、見えにくさがあることを示す情報（要配慮個人情報）の
// 取得になる。同意はここで得て、役割の保存は同意と一緒に DB が行う（register_role）。
//
// スクリーンリーダーで聞く前提で作る:
//   * 各文書は「要点」を先に置く。全文は長いので、開いたときだけ読める
//   * 同意のボタンの名前に「何に同意して、何が起きるか」まで入れる。
//     チェックボックスをいくつも押させる形は、読み上げで状態を追いにくいのでやめた
type Props =
  | { mode: "register"; role: Role; onDone: (profile: Profile) => void; onBack: () => void }
  | { mode: "reconsent"; role: Role; onDone: () => void; onSignOut: () => void };

export function ConsentScreen(props: Props) {
  const { role, mode } = props;
  const docs = documentsFor(role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agreeLabel =
    mode === "reconsent"
      ? "同意して続ける"
      : role === "requester"
        ? "同意して、読んでもらう側で登録する"
        : "同意して、読む側で登録する";

  async function agree() {
    setBusy(true);
    setError(null);
    try {
      if (props.mode === "register") {
        const profile = await registerRole(role);
        await notifyStateChange(
          role === "requester" ? "読んでもらう側で登録しました" : "読む側で登録しました",
        );
        props.onDone(profile);
      } else {
        await reconsent(role);
        await notifyStateChange("同意しました");
        props.onDone();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const text = message.includes("CONSENT_VERSION_MISMATCH")
        ? "アプリが古いため登録できません。アプリを新しくしてから、もう一度お試しください。"
        : "登録できませんでした。通信を確認して、もう一度お試しください。";
      setError(text);
      await notifyStateChange(text, "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        {mode === "reconsent" ? "規約が新しくなりました" : "登録の前に"}
      </Text>
      <Text style={styles.lead}>
        {mode === "reconsent"
          ? "続けて使うには、新しい内容に同意してください。"
          : `次の${docs.length}つに同意いただくと、登録します。まず要点だけお読みください。全文も開けます。`}
      </Text>

      {docs.map((doc) => (
        <DocumentCard key={doc.id} doc={doc} />
      ))}

      {error ? (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      ) : null}

      <View style={{ height: space.md }} />
      <BigButton label={busy ? "登録しています" : agreeLabel} onPress={agree} disabled={busy} />
      <View style={{ height: space.sm }} />
      {props.mode === "register" ? (
        <BigButton
          label="同意しないで戻る"
          hint="役割を選び直せます。読んでもらう側の同意をしない場合も、読む側では登録できます"
          variant="secondary"
          onPress={props.onBack}
        />
      ) : (
        <BigButton label="同意しないでログアウトする" variant="secondary" onPress={props.onSignOut} />
      )}
    </ScrollView>
  );
}

function DocumentCard({ doc }: { doc: LegalDocument }) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.card}>
      <Text style={styles.docTitle} accessibilityRole="header">
        {doc.title}
      </Text>
      {doc.summary.map((line, i) => (
        <Text key={i} style={styles.summary}>
          ・{line}
        </Text>
      ))}

      <View style={{ height: space.sm }} />
      <BigButton
        label={open ? `${doc.title}の全文を閉じる` : `${doc.title}の全文を読む`}
        variant="secondary"
        onPress={() => setOpen((v) => !v)}
      />

      {open
        ? doc.sections.map((section) => (
            <View key={section.heading} style={{ marginTop: space.md }}>
              <Text style={styles.sectionHeading} accessibilityRole="header">
                {section.heading}
              </Text>
              {section.paragraphs.map((p, i) => (
                <Text key={i} style={styles.paragraph}>
                  {p}
                </Text>
              ))}
            </View>
          ))
        : null}

      <Text style={styles.version}>版：{doc.version}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.sm },
  lead: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 32, marginBottom: space.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    marginBottom: space.md,
    padding: space.md,
  },
  docTitle: { color: colors.primary, fontSize: typeScale.body, fontWeight: "800", marginBottom: space.sm },
  summary: { color: colors.text, fontSize: typeScale.caption, lineHeight: 30, marginBottom: space.xs },
  sectionHeading: { color: colors.text, fontSize: typeScale.caption, fontWeight: "700", marginBottom: space.xs },
  paragraph: { color: colors.textMuted, fontSize: typeScale.caption, lineHeight: 28, marginBottom: space.xs },
  version: { color: colors.textMuted, fontSize: 14, marginTop: space.sm },
  error: { color: colors.danger, fontSize: typeScale.body, marginTop: space.md },
});

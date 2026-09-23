import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { supabase } from "../lib/supabase";
import { notifyStateChange } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

// マジックリンクではなく6桁コードを使う。
// リンクだとメールアプリ→ブラウザ→アプリと3回画面が変わり、
// スクリーンリーダー利用者の離脱率が跳ね上がるため。
export function SignInScreen() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);

    if (error) {
      setError("コードを送れませんでした。メールアドレスを確認してください。");
      await notifyStateChange("コードを送れませんでした", "failed");
      return;
    }
    setSent(true);
    await notifyStateChange("メールに6桁のコードを送りました");
  }

  async function verify() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);

    if (error) {
      setError("コードが違います。");
      await notifyStateChange("コードが違います", "failed");
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title} accessibilityRole="header">
        eyes-bridge
      </Text>
      <Text style={styles.lead}>
        見えにくいものを、誰かに読んでもらえます。
      </Text>

      {!sent ? (
        <>
          <Text style={styles.label} nativeID="emailLabel">
            メールアドレス
          </Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            accessibilityLabel="メールアドレス"
            accessibilityLabelledBy="emailLabel"
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
          />
          <BigButton
            label={busy ? "送信中" : "コードを送る"}
            hint="入力したメールアドレスに6桁のコードが届きます"
            onPress={sendCode}
            disabled={busy || email.trim().length === 0}
          />
        </>
      ) : (
        <>
          <Text style={styles.label} nativeID="codeLabel">
            メールに届いた6桁のコード
          </Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            accessibilityLabel="6桁のコード"
            accessibilityLabelledBy="codeLabel"
          />
          <BigButton
            label={busy ? "確認中" : "ログイン"}
            onPress={verify}
            disabled={busy || code.trim().length < 6}
          />
          <View style={{ height: space.sm }} />
          <BigButton
            label="メールアドレスを入れ直す"
            variant="secondary"
            onPress={() => {
              setSent(false);
              setCode("");
            }}
          />
        </>
      )}

      {error ? (
        // live region にしない。同じ内容を notifyStateChange で既に伝えており、
        // 両方あると Android で2回読まれる。
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.md, justifyContent: "center" },
  title: { color: colors.primary, fontSize: typeScale.hero, fontWeight: "800", marginBottom: space.sm },
  lead: { color: colors.textMuted, fontSize: typeScale.body, marginBottom: space.lg, lineHeight: 32 },
  label: { color: colors.text, fontSize: typeScale.body, marginBottom: space.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 2,
    borderRadius: 12,
    color: colors.text,
    fontSize: typeScale.body,
    marginBottom: space.md,
    minHeight: 64,
    paddingHorizontal: space.md,
  },
  error: { color: colors.danger, fontSize: typeScale.body, marginTop: space.md },
});

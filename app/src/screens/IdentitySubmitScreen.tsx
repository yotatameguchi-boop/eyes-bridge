import { useState } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { BigButton } from "../components/BigButton";
import { ID_KINDS, submitIdentity, type IdentityKind } from "../lib/identity";
import { notifyStateChange } from "../lib/a11y";
import { colors, space, type as typeScale } from "../theme";

type Slot = "front" | "back" | "selfie";

const SLOT_LABEL: Record<Slot, string> = {
  front: "書類の表面",
  back: "書類の裏面",
  selfie: "自分の顔",
};

export function IdentitySubmitScreen({
  userId,
  rejectReason,
  onSubmitted,
}: {
  userId: string;
  rejectReason?: string;
  onSubmitted: () => void;
}) {
  const [kind, setKind] = useState<IdentityKind | null>(null);
  const [shots, setShots] = useState<Partial<Record<Slot, { uri: string; base64: string }>>>({});
  const [busy, setBusy] = useState(false);

  const spec = ID_KINDS.find((k) => k.value === kind);
  const needed: Slot[] = spec ? (spec.needsBack ? ["front", "back", "selfie"] : ["front", "selfie"]) : [];
  const ready = needed.every((slot) => shots[slot]);

  async function capture(slot: Slot) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      await notifyStateChange("カメラを使う許可が必要です", "failed");
      return;
    }

    const shot = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      base64: true,
      exif: false, // 撮影場所が書類に付いて回るのを避ける
      cameraType: slot === "selfie" ? ImagePicker.CameraType.front : ImagePicker.CameraType.back,
    });

    if (shot.canceled || !shot.assets[0].base64) return;

    setShots((s) => ({
      ...s,
      [slot]: { uri: shot.assets[0].uri, base64: shot.assets[0].base64! },
    }));
    await notifyStateChange(`${SLOT_LABEL[slot]}を撮りました`);
  }

  async function submit() {
    if (!kind || !ready) return;
    setBusy(true);
    try {
      await submitIdentity(userId, kind, {
        frontBase64: shots.front!.base64,
        selfieBase64: shots.selfie!.base64,
        backBase64: shots.back?.base64,
      });
      await notifyStateChange("提出しました。運営の確認をお待ちください");
      onSubmitted();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      await notifyStateChange(
        message.includes("identity_one_open_per_user")
          ? "すでに審査待ちの提出があります"
          : "提出できませんでした",
        "failed",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!kind) {
    return (
      <ScrollView contentContainerStyle={styles.root}>
        <Text style={styles.title} accessibilityRole="header">
          本人確認
        </Text>

        {rejectReason ? (
          <Text style={styles.reject} role="alert">
            前回は承認されませんでした：{rejectReason}
          </Text>
        ) : null}

        <Text style={styles.lead}>
          他の人のカメラ映像を見ることになるため、本人確認をお願いしています。
        </Text>

        <Text style={styles.subhead} accessibilityRole="header">
          使う書類を選んでください
        </Text>

        {ID_KINDS.map((k) => (
          <View key={k.value} style={{ marginBottom: space.sm }}>
            <BigButton
              label={k.label}
              variant="secondary"
              hint={k.note ?? `${k.label}を撮影します`}
              onPress={() => setKind(k.value)}
            />
            {k.note ? <Text style={styles.note}>{k.note}</Text> : null}
          </View>
        ))}

        <Text style={styles.privacy}>
          画像は運営だけが見られます。審査が済んだら消します。
          個人番号（マイナンバー）と書類の番号は記録しません。
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        {spec!.label}
      </Text>
      {spec!.note ? (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {spec!.note}
        </Text>
      ) : null}

      {needed.map((slot) => (
        <View key={slot} style={{ marginBottom: space.md }}>
          <BigButton
            label={shots[slot] ? `${SLOT_LABEL[slot]}を撮り直す` : `${SLOT_LABEL[slot]}を撮る`}
            hint={
              slot === "selfie"
                ? "書類の写真と同じ人かを確認します"
                : "文字が読める明るさで、四隅が入るように撮ってください"
            }
            variant={shots[slot] ? "secondary" : "primary"}
            onPress={() => capture(slot)}
          />
          {shots[slot] ? (
            <Image
              source={{ uri: shots[slot]!.uri }}
              style={styles.preview}
              accessibilityLabel={`${SLOT_LABEL[slot]}の写真`}
            />
          ) : null}
        </View>
      ))}

      <BigButton
        label={busy ? "送信中" : "提出する"}
        onPress={submit}
        disabled={busy || !ready}
        hint={ready ? "運営の確認に進みます" : "必要な写真をすべて撮ってください"}
      />
      <View style={{ height: space.sm }} />
      <BigButton
        label="書類を選び直す"
        variant="secondary"
        onPress={() => {
          setKind(null);
          setShots({});
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, backgroundColor: colors.bg, padding: space.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: "800", marginBottom: space.sm },
  subhead: { color: colors.text, fontSize: typeScale.body, fontWeight: "700", marginBottom: space.sm, marginTop: space.md },
  lead: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 32 },
  note: { color: colors.primary, fontSize: typeScale.caption, lineHeight: 26, marginTop: space.xs },
  reject: { color: colors.danger, fontSize: typeScale.caption, lineHeight: 26, marginBottom: space.md },
  privacy: { color: colors.textMuted, fontSize: typeScale.caption, lineHeight: 26, marginTop: space.lg },
  preview: {
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 2,
    height: 180,
    marginTop: space.sm,
    resizeMode: "contain",
    width: "100%",
  },
});

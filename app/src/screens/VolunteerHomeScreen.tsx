import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Switch, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { VolunteerGateScreen } from "./VolunteerGateScreen";
import {
  AlreadyTakenError,
  claimRequest,
  fetchQueued,
  watchQueue,
  type QueueHandle,
  type QueuedRequest,
} from "../lib/requests";
import { fetchQuietPreset, QUIET_PRESETS, saveQuietPreset, type QuietPreset } from "../lib/quiet";
import { goOffline, goOnline } from "../lib/presence";
import { registerForPush, setupVoipPush } from "../lib/push";
import { endCall, markAnswered, ringIncoming, setupCallKit, stopRinging } from "../lib/calls";
import { fetchStanding, type VolunteerStanding } from "../lib/safety";
import { notifyStateChange } from "../lib/a11y";
import type { HelpRequest } from "../lib/supabase";
import type { Profile } from "../lib/session";
import { colors, space, type as typeScale } from "../theme";

type Props = {
  profile: Profile;
  onAccepted: (request: HelpRequest) => void;
};

export function VolunteerHomeScreen({ profile, onAccepted }: Props) {
  const [standing, setStanding] = useState<VolunteerStanding | null>(null);
  const [loadingStanding, setLoadingStanding] = useState(true);
  const [available, setAvailable] = useState(false);
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [quiet, setQuiet] = useState<QuietPreset | null>(null);
  const [quietOpen, setQuietOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshStanding = useCallback(async () => {
    setLoadingStanding(true);
    setStanding(await fetchStanding(profile.id).catch(() => null));
    setLoadingStanding(false);
  }, [profile.id]);

  useEffect(() => {
    void refreshStanding();
  }, [refreshStanding]);

  const approved = standing?.reviewState === "approved" && standing.agreedToTerms;

  useEffect(() => {
    void fetchQuietPreset(profile.id).then(setQuiet).catch(() => {});
  }, [profile.id]);

  async function chooseQuiet(preset: QuietPreset) {
    try {
      await saveQuietPreset(profile.id, preset);
      setQuiet(preset);
      setQuietOpen(false);
      await notifyStateChange(
        preset.start ? `${preset.label}は鳴らしません` : "いつでも鳴らします",
      );
    } catch {
      await notifyStateChange("設定できませんでした", "failed");
    }
  }

  const accept = useCallback(
    async (requestId: string) => {
      setBusy(true);
      try {
        const claimed = await claimRequest(requestId);
        markAnswered(requestId);
        await notifyStateChange("繋がりました", "connected");
        onAccepted(claimed);
      } catch (e) {
        const message = e instanceof Error ? e.message : "";

        if (e instanceof AlreadyTakenError) {
          // 負けは失敗ではない。誰かが対応できたということ。
          stopRinging(requestId, "taken");
          setQueue((q) => q.filter((r) => r.id !== requestId));
          await notifyStateChange("ほかの人が対応しました");
        } else if (message.includes("NOT_APPROVED")) {
          stopRinging(requestId, "cancelled");
          await notifyStateChange("待機できる状態ではありません", "failed");
          await refreshStanding();
        } else if (message.includes("BLOCKED")) {
          stopRinging(requestId, "cancelled");
          setQueue((q) => q.filter((r) => r.id !== requestId));
          await notifyStateChange("この依頼は受けられません", "failed");
        } else {
          await notifyStateChange("受けられませんでした", "failed");
        }
      } finally {
        setBusy(false);
      }
    },
    [onAccepted, refreshStanding],
  );

  // CallKit は起動時に1度だけ配線する。
  // 通知タップではなく OS の着信画面から直接 accept が呼ばれる経路。
  useEffect(() => {
    void setupCallKit({
      onAnswer: (requestId) => void accept(requestId),
      onDecline: (requestId) => {
        endCall(requestId);
        setQueue((q) => q.filter((r) => r.id !== requestId));
      },
    });
  }, [accept]);

  // iOS の VoIP 着信。アプリが終了していてもここに入ってくるので、
  // 受け取ったらその場で鳴らす（待機トグルの状態には依存させない）。
  useEffect(() => {
    return setupVoipPush(profile.id, ({ requestId }) => ringIncoming(requestId));
  }, [profile.id]);

  useEffect(() => {
    if (!available || !approved) {
      setQueue([]);
      return;
    }

    let handle: QueueHandle | null = null;
    let alive = true;

    void (async () => {
      // 画面を開く前から並んでいた依頼を先に拾う
      const existing = await fetchQueued(profile.language).catch(() => []);
      if (!alive) return;
      setQueue(existing);

      handle = watchQueue(profile.language, {
        // 一覧に足すだけで、電話の着信画面は出さない。
        // 以前はアプリを開いている全員を毎回鳴らしており、サーバの段階的な着信
        // （最初は数人だけ）をすり抜けていた。鳴らすのはサーバからの着信だけにする
        onQueued: (request) =>
          setQueue((q) => (q.some((r) => r.id === request.id) ? q : [...q, request])),
        // 他の人が取った・取り下げられた依頼は一覧から外し、鳴っていれば止める
        // （「鳴ったのに出たら終わっていた」を減らす）
        onClosed: (requestId) => {
          setQueue((q) => q.filter((r) => r.id !== requestId));
          stopRinging(requestId, "taken");
        },
      });
    })();

    return () => {
      alive = false;
      handle?.unsubscribe();
    };
  }, [available, approved, profile.language]);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      if (next) {
        await registerForPush(profile.id);
        await goOnline(profile.id, profile.language);
        await notifyStateChange("待機を始めました");
      } else {
        await goOffline(profile.id);
        await notifyStateChange("待機をやめました");
      }
      setAvailable(next);
    } finally {
      setBusy(false);
    }
  }

  if (loadingStanding) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!standing || !approved) {
    return (
      <VolunteerGateScreen
        userId={profile.id}
        standing={
          standing ?? {
            reviewState: "pending",
            agreedToTerms: false,
            acceptedCount: 0,
            identityState: null,
            identityRejectReason: "",
          }
        }
        onRefresh={() => void refreshStanding()}
      />
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel} nativeID="availableLabel">
          {available ? "待機中" : "待機していません"}
        </Text>
        <Switch
          value={available}
          onValueChange={toggle}
          disabled={busy}
          accessibilityLabel="待機する"
          accessibilityHint="オンにすると依頼の着信を受け取ります"
          accessibilityLabelledBy="availableLabel"
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor={colors.text}
        />
      </View>

      {/* 鳴らさない時間帯。サーバはこの時間帯の人を着信の段から外す */}
      <View style={{ height: space.sm }} />
      <BigButton
        label={`鳴らさない時間帯：${quiet ? quiet.label : "未設定"}`}
        hint={quietOpen ? "選択肢を閉じます" : "選択肢を開きます"}
        variant="secondary"
        onPress={() => setQuietOpen((v) => !v)}
      />
      {quietOpen
        ? QUIET_PRESETS.map((preset) => (
            <View key={preset.id} style={{ marginTop: space.xs }}>
              <BigButton
                label={preset.label}
                variant={quiet?.id === preset.id ? "primary" : "secondary"}
                hint={quiet?.id === preset.id ? "いまの設定です" : "この時間帯に変えます"}
                onPress={() => chooseQuiet(preset)}
              />
            </View>
          ))
        : null}

      {/* live region にしない。待機の切り替えは notifyStateChange で、
          新しい依頼は OS の着信画面で伝えている。重ねると2回読まれる。 */}
      <Text style={styles.counter}>
        {!available
          ? "待機をオンにすると依頼が届きます"
          : queue.length === 0
            ? "いま待っている人はいません"
            : `${queue.length} 件の依頼`}
      </Text>

      <FlatList
        data={queue}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        renderItem={({ item }) => (
          <BigButton
            label="受ける"
            hint={`${new Date(item.created_at).toLocaleTimeString("ja-JP")} に届いた依頼を受けます`}
            onPress={() => accept(item.id)}
            disabled={busy}
          />
        )}
        contentContainerStyle={{ paddingTop: space.md }}
      />

      <Text style={styles.note}>
        通話中の映像は保存されません。相手には自分のカメラは映りません。
        通話のあとで通報とブロックができます。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.md },
  center: { alignItems: "center", backgroundColor: colors.bg, flex: 1, justifyContent: "center" },
  toggleRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 80,
    paddingHorizontal: space.md,
  },
  toggleLabel: { color: colors.text, fontSize: typeScale.body, fontWeight: "700" },
  counter: { color: colors.textMuted, fontSize: typeScale.caption, marginTop: space.md },
  note: { color: colors.textMuted, fontSize: typeScale.caption, lineHeight: 26, marginTop: space.md },
});

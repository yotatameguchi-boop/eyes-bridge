import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BigButton } from "../components/BigButton";
import { createHelpRequest, endRequest, watchRequest, type QueueHandle } from "../lib/requests";
import { watchAvailableCount } from "../lib/presence";
import { notifyStateChange, say } from "../lib/a11y";
import type { HelpRequest } from "../lib/supabase";
import { colors, space, type as typeScale } from "../theme";

type Props = {
  onConnected: (request: HelpRequest) => void;
  onReadAloud: () => void;
};

// 誰も取らないまま待たせ続けない。3分は DB 側の expire_stale_requests と揃える。
const GIVE_UP_MS = 3 * 60 * 1000;

export function RequesterHomeScreen({ onConnected, onReadAloud }: Props) {
  const [waiting, setWaiting] = useState<HelpRequest | null>(null);
  const [availableCount, setAvailableCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const watchRef = useRef<QueueHandle | null>(null);

  useEffect(() => {
    const handle = watchAvailableCount("ja", setAvailableCount);
    return () => handle.unsubscribe();
  }, []);

  // 待ち時間を秒で持つ。無音で待たされるのが一番不安なので、
  // 一定間隔で「まだ探しています」と声に出す。
  useEffect(() => {
    if (!waiting) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(Math.floor(ms / 1000));
      if (ms > GIVE_UP_MS) void giveUp();
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting?.id]);

  useEffect(() => {
    if (elapsed > 0 && elapsed % 20 === 0) void say("まだ探しています");
  }, [elapsed]);

  const stopWatching = useCallback(() => {
    watchRef.current?.unsubscribe();
    watchRef.current = null;
  }, []);

  async function ask() {
    try {
      const request = await createHelpRequest("ja");
      setWaiting(request);
      await notifyStateChange("読んでくれる人を探しています");

      watchRef.current = watchRequest(request.id, (next) => {
        if (next.state === "active") {
          stopWatching();
          setWaiting(null);
          void notifyStateChange("繋がりました。カメラを見せたいものに向けてください", "connected");
          onConnected(next);
        }
        if (next.state === "timed_out") {
          stopWatching();
          setWaiting(null);
          void notifyStateChange("今は誰も見つかりませんでした", "failed");
        }
      });
    } catch {
      await notifyStateChange("依頼を出せませんでした。通信を確認してください", "failed");
    }
  }

  async function cancel() {
    if (!waiting) return;
    stopWatching();
    await endRequest(waiting.id, "cancelled");
    setWaiting(null);
    await notifyStateChange("依頼をやめました");
  }

  async function giveUp() {
    if (!waiting) return;
    stopWatching();
    await endRequest(waiting.id, "cancelled");
    setWaiting(null);
    await notifyStateChange("今は誰も見つかりませんでした。読み上げを使えます", "failed");
  }

  if (waiting) {
    return (
      <View style={styles.root}>
        {/* live region にしない。秒数が毎秒変わるので、Android の TalkBack が
            「1秒、2秒…」と毎秒読み上げて他の声をかき消す。
            経過は20秒ごとの「まだ探しています」で伝えている。 */}
        <View style={styles.status}>
          <Text style={styles.statusTitle} accessibilityRole="header">
            探しています
          </Text>
          <Text style={styles.statusBody}>{elapsed} 秒</Text>
        </View>
        <BigButton label="やめる" variant="danger" onPress={cancel} />
        <View style={{ height: space.sm }} />
        <BigButton
          label="待たずに読み上げを使う"
          hint="人を待たずに、文字を機械が読み上げます"
          variant="secondary"
          onPress={async () => {
            await cancel();
            onReadAloud();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* live region にしない。待機人数は人の出入りのたびに変わり、
          そのたびに読み上げると操作中の声に割り込む。画面の先頭に置いてあるので、
          知りたいときは指でなぞれば聞ける。 */}
      <Text style={styles.availability}>
        {availableCount === null
          ? "待機人数を確認中"
          : availableCount === 0
            ? "いま待機している人はいません"
            : `いま ${availableCount} 人が待機中`}
      </Text>

      <BigButton
        label="読んでもらう"
        hint="押すと、待機中のボランティアに繋がります"
        onPress={ask}
        hero
      />

      <View style={{ height: space.md }} />
      <BigButton
        label="機械に読ませる"
        hint="人を待たずに、写した文字をその場で読み上げます"
        variant="secondary"
        onPress={onReadAloud}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.md, paddingBottom: space.lg },
  availability: {
    color: colors.textMuted,
    fontSize: typeScale.caption,
    marginBottom: space.sm,
    textAlign: "center",
  },
  status: { flex: 1, alignItems: "center", justifyContent: "center" },
  statusTitle: { color: colors.text, fontSize: typeScale.title, fontWeight: "800" },
  statusBody: { color: colors.primary, fontSize: typeScale.hero, fontWeight: "800", marginTop: space.md },
});

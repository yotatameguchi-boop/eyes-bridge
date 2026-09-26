import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { LiveKitRoom, VideoTrack, useTracks } from "@livekit/react-native";
import { Track } from "livekit-client";
import * as ScreenCapture from "expo-screen-capture";
import { BigButton } from "../components/BigButton";
import { fetchJoinInfo, startAudio, stopAudio, type JoinInfo } from "../lib/livekit";
import { endRequest } from "../lib/requests";
import { endCall } from "../lib/calls";
import { notifyStateChange, stopSpeaking } from "../lib/a11y";
import { EMERGENCY_NOTICE_FOR_VOLUNTEER } from "../lib/cautions";
import type { HelpRequest } from "../lib/supabase";
import { colors, space, type as typeScale } from "../theme";

type Props = {
  request: HelpRequest;
  role: "requester" | "volunteer";
  onEnded: () => void;
};

export function CallScreen({ request, role, onEnded }: Props) {
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        // 通話中に読み上げが被ると相手の声が聞こえない
        stopSpeaking();
        await startAudio();
        const info = await fetchJoinInfo(request.id);
        if (alive) setJoin(info);
      } catch {
        if (alive) {
          setError("通話に入れませんでした");
          void notifyStateChange("通話に入れませんでした", "failed");
        }
      }
    })();

    return () => {
      alive = false;
      void stopAudio();
    };
  }, [request.id]);

  async function hangUp() {
    endCall(request.id);
    await endRequest(request.id, "completed");
    await notifyStateChange("通話を終わりました");
    onEnded();
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.message} role="alert">{error}</Text>
        <BigButton label="戻る" onPress={onEnded} />
      </View>
    );
  }

  if (!join) {
    return (
      <View style={styles.center} accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.message}>通話を準備しています</Text>
      </View>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={join.url}
      token={join.token}
      connect
      // 依頼者だけがカメラを出す。ボランティアは声だけで参加する。
      video={role === "requester"}
      audio
      options={{
        // 文字を読むための通話。動きより解像度を優先する。
        publishDefaults: { videoSimulcastLayers: [], videoCodec: "vp8" },
      }}
      onError={() => {
        setError("通話が切れました");
        void notifyStateChange("通話が切れました", "failed");
      }}
    >
      <RoomView role={role} onHangUp={hangUp} />
    </LiveKitRoom>
  );
}

const CAPTURE_KEY = "eyes-bridge-call";

function RoomView({ role, onHangUp }: { role: "requester" | "volunteer"; onHangUp: () => void }) {
  // ボランティアの端末では、通話中の画面録画とスクリーンショットを止める。
  // 映るのは通帳や診断書かもしれない。以前は規約で禁じているだけだった。
  // Android は録画・スクショとも、iOS は録画（11以降）とスクショ（13以降）を防ぐ。
  // 別のスマホで画面を撮られることまでは防げない。
  useEffect(() => {
    if (role !== "volunteer") return;
    void ScreenCapture.preventScreenCaptureAsync(CAPTURE_KEY);
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(CAPTURE_KEY);
    };
  }, [role]);

  const tracks = useTracks([Track.Source.Camera]);
  const remoteCamera = tracks.find((t) => !t.participant.isLocal);

  useEffect(() => {
    void notifyStateChange(
      role === "requester"
        ? "繋がりました。見せたいものにカメラを向けてください"
        : "繋がりました。相手のカメラが映ります",
      "connected",
    );
  }, [role]);

  return (
    <View style={styles.root}>
      {role === "volunteer" ? (
        <View style={styles.video}>
          {remoteCamera ? (
            <VideoTrack trackRef={remoteCamera} style={StyleSheet.absoluteFill} objectFit="contain" />
          ) : (
            <Text style={styles.message}>映像を待っています</Text>
          )}
        </View>
      ) : (
        // 依頼者の画面には映像を出さない。
        // 見えない人にプレビューを見せても意味が無く、
        // 発熱と電池の消費だけが増える。
        <View
          style={styles.video}
          accessible
          accessibilityLabel="通話中です。見せたいものにカメラを向けてください"
        >
          <Text style={styles.callingLabel}>通話中</Text>
        </View>
      )}

      {role === "volunteer" ? (
        // 通話中は映像に集中しているので、画面に常に出しておく
        <Text style={styles.emergency}>{EMERGENCY_NOTICE_FOR_VOLUNTEER}</Text>
      ) : null}

      <BigButton label="通話を終わる" variant="danger" onPress={onHangUp} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.md },
  emergency: {
    color: colors.primary,
    fontSize: typeScale.caption,
    fontWeight: "700",
    lineHeight: 26,
    marginBottom: space.md,
  },
  center: {
    alignItems: "center",
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: "center",
    padding: space.md,
  },
  video: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 16,
    flex: 1,
    justifyContent: "center",
    marginBottom: space.md,
    overflow: "hidden",
  },
  callingLabel: { color: colors.primary, fontSize: typeScale.hero, fontWeight: "800" },
  message: { color: colors.text, fontSize: typeScale.body, marginVertical: space.md, textAlign: "center" },
});

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StatusBar, StyleSheet, View } from "react-native";
import { registerGlobals } from "@livekit/react-native";
import { BigButton } from "./src/components/BigButton";
import { SignInScreen } from "./src/screens/SignInScreen";
import { RoleSelectScreen } from "./src/screens/RoleSelectScreen";
import { RequesterHomeScreen } from "./src/screens/RequesterHomeScreen";
import { VolunteerHomeScreen } from "./src/screens/VolunteerHomeScreen";
import { CallScreen } from "./src/screens/CallScreen";
import { ReadAloudScreen } from "./src/screens/ReadAloudScreen";
import { ReportScreen } from "./src/screens/ReportScreen";
import { signOut, useSession, type Profile } from "./src/lib/session";
import { onNotificationTapped } from "./src/lib/push";
import { claimRequest, AlreadyTakenError } from "./src/lib/requests";
import { notifyStateChange } from "./src/lib/a11y";
import type { HelpRequest } from "./src/lib/supabase";
import { colors, space } from "./src/theme";

// WebRTC のグローバル（RTCPeerConnection など）を RN に生やす。
// import 副作用なので、どの画面より先に一度だけ呼ぶ必要がある。
registerGlobals();

type Screen =
  | { name: "home" }
  | { name: "call"; request: HelpRequest }
  | { name: "report"; requestId: string }
  | { name: "read" };

export default function App() {
  const { session, profile, loading, setProfile } = useSession();
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const openCall = useCallback((request: HelpRequest) => {
    setScreen({ name: "call", request });
  }, []);

  // 通知をタップして起動した場合。CallKit の着信画面を経由しない経路。
  useEffect(() => {
    if (profile?.role !== "volunteer") return;

    const sub = onNotificationTapped(async (requestId) => {
      try {
        const claimed = await claimRequest(requestId);
        openCall(claimed);
      } catch (e) {
        await notifyStateChange(
          e instanceof AlreadyTakenError ? "ほかの人が対応しました" : "受けられませんでした",
          e instanceof AlreadyTakenError ? "progress" : "failed",
        );
      }
    });

    return () => sub.remove();
  }, [profile?.role, openCall]);

  if (loading) {
    return (
      <Shell>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <SignInScreen />
      </Shell>
    );
  }

  if (!profile) {
    return (
      <Shell>
        <RoleSelectScreen onDone={(p: Profile) => setProfile(p)} />
      </Shell>
    );
  }

  if (screen.name === "call") {
    return (
      <Shell>
        <CallScreen
          request={screen.request}
          role={profile.role}
          // 通話のあとに必ず通報の入口を通す。
          // 設定の奥に置くと、嫌な思いをした人ほど辿り着けない。
          onEnded={() => setScreen({ name: "report", requestId: screen.request.id })}
        />
      </Shell>
    );
  }

  if (screen.name === "report") {
    return (
      <Shell>
        <ReportScreen
          requestId={screen.requestId}
          onDone={() => setScreen({ name: "home" })}
        />
      </Shell>
    );
  }

  if (screen.name === "read") {
    return (
      <Shell>
        <ReadAloudScreen onBack={() => setScreen({ name: "home" })} />
      </Shell>
    );
  }

  return (
    <Shell>
      {profile.role === "requester" ? (
        <RequesterHomeScreen
          onConnected={openCall}
          onReadAloud={() => setScreen({ name: "read" })}
        />
      ) : (
        <VolunteerHomeScreen profile={profile} onAccepted={openCall} />
      )}
      <View style={styles.footer}>
        <BigButton label="ログアウト" variant="secondary" onPress={signOut} />
      </View>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar barStyle="light-content" />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  shell: { backgroundColor: colors.bg, flex: 1 },
  center: { alignItems: "center", flex: 1, justifyContent: "center" },
  footer: { padding: space.md, paddingTop: 0 },
});

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StatusBar, StyleSheet, View } from "react-native";
import { registerGlobals } from "@livekit/react-native";
import { BigButton } from "./src/components/BigButton";
import { SignInScreen } from "./src/screens/SignInScreen";
import { RoleSelectScreen } from "./src/screens/RoleSelectScreen";
import { ConsentScreen } from "./src/screens/ConsentScreen";
import { DeleteAccountScreen } from "./src/screens/DeleteAccountScreen";
import { RequesterHomeScreen } from "./src/screens/RequesterHomeScreen";
import { VolunteerHomeScreen } from "./src/screens/VolunteerHomeScreen";
import { CallScreen } from "./src/screens/CallScreen";
import { ReadAloudScreen } from "./src/screens/ReadAloudScreen";
import { ReportScreen } from "./src/screens/ReportScreen";
import { fetchMissingConsents, signOut, useSession, type Profile, type Role } from "./src/lib/session";
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
  | { name: "read" }
  | { name: "delete" };

export default function App() {
  const { session, profile, loading, setProfile } = useSession();
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  // 役割を選んだが、まだ同意していない（＝まだ何も保存していない）
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  // 文書の版が上がって、同意し直しが要る
  const [needsReconsent, setNeedsReconsent] = useState(false);

  useEffect(() => {
    if (!profile) {
      setNeedsReconsent(false);
      return;
    }
    let alive = true;
    void fetchMissingConsents()
      .then((missing) => alive && setNeedsReconsent(missing.length > 0))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [profile?.id, profile?.role]);

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
        {pendingRole ? (
          <ConsentScreen
            mode="register"
            role={pendingRole}
            onDone={(p: Profile) => {
              setPendingRole(null);
              setProfile(p);
            }}
            onBack={() => setPendingRole(null)}
          />
        ) : (
          <RoleSelectScreen onPick={setPendingRole} />
        )}
      </Shell>
    );
  }

  if (needsReconsent) {
    return (
      <Shell>
        <ConsentScreen
          mode="reconsent"
          role={profile.role}
          onDone={() => setNeedsReconsent(false)}
          onSignOut={signOut}
        />
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

  if (screen.name === "delete") {
    return (
      <Shell>
        <DeleteAccountScreen onCancel={() => setScreen({ name: "home" })} />
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
        <View style={{ height: space.sm }} />
        {/* App Store は、アカウントを作れるアプリにアプリ内での削除を求めている */}
        <BigButton
          label="退会する"
          hint="確認の画面に進みます。まだ退会はしません"
          variant="secondary"
          onPress={() => setScreen({ name: "delete" })}
        />
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

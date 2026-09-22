// 端末を鳴らすためのトークン登録。
//
// iOS と Android で経路が違う:
//   iOS    … PushKit の VoIP push。アプリが終了していても
//            CallKit の着信画面を出せる唯一の方法。
//   Android… FCM（Expo push）+ ConnectionService。
//
// iOS で通常の通知にすると、アプリ終了中は通知が1枚出るだけで
// 着信にならない。ボランティアが気づかなければ依頼は時間切れになる。
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import VoipPushNotification from "expo-voip-push-notification";
import { supabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function saveToken(userId: string, token: string, kind: "expo" | "apns_voip") {
  await supabase.from("volunteer_status").upsert({
    user_id: userId,
    push_token: token,
    push_kind: kind,
    last_seen_at: new Date().toISOString(),
  });
}

export async function registerForPush(userId: string): Promise<string | null> {
  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;

  if (!granted) {
    const asked = await Notifications.requestPermissionsAsync();
    granted = asked.granted;
  }
  if (!granted) return null;

  if (Platform.OS === "android") {
    // 着信は最大優先度でないと、画面オフの端末で鳴らない
    await Notifications.setNotificationChannelAsync("incoming", {
      name: "依頼の着信",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 400, 200, 400],
      sound: "default",
      bypassDnd: false,
    });
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync();

  // iOS では VoIP トークンのほうを本命として上書きするので、
  // ここでは Android のときだけ expo トークンを保存する。
  if (Platform.OS !== "ios") await saveToken(userId, token, "expo");

  return token;
}

type IncomingHandler = (payload: {
  requestId: string;
  roomName: string;
}) => string | undefined;

/**
 * iOS の VoIP 着信を配線する。
 *
 * onIncoming は CallKit の callUUID を返すこと。
 * iOS は「VoIP push を受けたら必ず着信を報告する」ことを要求しており、
 * 報告し終えたことを onVoipNotificationCompleted で伝えないと、
 * 次第にアプリへの push が止められる。
 */
export function setupVoipPush(userId: string, onIncoming: IncomingHandler): () => void {
  if (Platform.OS !== "ios") return () => {};

  VoipPushNotification.addEventListener("register", (token) => {
    void saveToken(userId, token, "apns_voip");
  });

  VoipPushNotification.addEventListener("notification", (raw) => {
    const payload = raw as { requestId?: string; roomName?: string };
    if (!payload.requestId) return;

    const callUUID = onIncoming({
      requestId: payload.requestId,
      roomName: payload.roomName ?? "",
    });

    if (callUUID) VoipPushNotification.onVoipNotificationCompleted(callUUID);
  });

  // アプリが push で起動した場合、リスナーを張る前に届いた分がここに溜まっている
  VoipPushNotification.addEventListener("didLoadWithEvents", (events) => {
    for (const event of events) {
      if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent) {
        void saveToken(userId, event.data as string, "apns_voip");
      }
      if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent) {
        const payload = event.data as { requestId?: string; roomName?: string };
        if (payload.requestId) {
          const callUUID = onIncoming({
            requestId: payload.requestId,
            roomName: payload.roomName ?? "",
          });
          if (callUUID) VoipPushNotification.onVoipNotificationCompleted(callUUID);
        }
      }
    }
  });

  VoipPushNotification.registerVoipToken();

  return () => {
    VoipPushNotification.removeEventListener("register");
    VoipPushNotification.removeEventListener("notification");
    VoipPushNotification.removeEventListener("didLoadWithEvents");
  };
}

/** 通知タップで起動したときに、どの依頼かを取り出す。 */
export function requestIdFromNotification(
  response: Notifications.NotificationResponse,
): string | null {
  const data = response.notification.request.content.data as Record<string, unknown>;
  return data?.type === "incoming_request" && typeof data.requestId === "string"
    ? data.requestId
    : null;
}

export function onNotificationTapped(handler: (requestId: string) => void) {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const requestId = requestIdFromNotification(response);
    if (requestId) handler(requestId);
  });
}

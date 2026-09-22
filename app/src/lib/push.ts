// 端末を鳴らすためのトークン登録。
//
// 現状 Expo push（FCM / APNs の通常通知）で実装している。
// これで「通知が1枚出る → タップして受ける」までは動く。
//
// 本番で CallKit の着信画面（アプリ終了状態から電話として鳴る）まで
// やる場合は iOS だけ PushKit の VoIP push に差し替える。
// サーバ側の送信処理は supabase/functions/_shared/apns.ts に実装済みで、
// volunteer_status.push_kind を 'apns_voip' にすればそちらに流れる。
// 端末側は react-native-voip-push-notification の導入が別途必要
// （Expo config plugin が無いので prebuild 後の native 編集になる）。
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { supabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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

  await supabase.from("volunteer_status").upsert({
    user_id: userId,
    push_token: token,
    push_kind: "expo",
    last_seen_at: new Date().toISOString(),
  });

  return token;
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

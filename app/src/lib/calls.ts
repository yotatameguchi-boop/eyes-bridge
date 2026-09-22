// CallKit / ConnectionService の配線。
//
// なぜ普通のモーダルではなく OS の着信画面を使うのか:
//   ボランティアは普段アプリを開いていない。通知バナー1枚では
//   気づかれずに依頼が時間切れになる。電話として鳴れば、
//   ロック画面からでも、運転中でも、片手で取れる。
//   そして「取る / 拒否」の2択は、OS 側が完全にアクセシブルにしてある。
import { Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";
import * as Crypto from "expo-crypto";

type Handlers = {
  onAnswer: (requestId: string) => void;
  onDecline: (requestId: string) => void;
};

// CallKit の callUUID と、こちらの依頼 ID の対応表。
// CallKit 側は自分で決めた UUID しか返してこないので、必ず持つ。
const callToRequest = new Map<string, string>();
const requestToCall = new Map<string, string>();
let configured = false;

export async function setupCallKit(handlers: Handlers): Promise<void> {
  if (configured) return;

  await RNCallKeep.setup({
    ios: {
      appName: "eyes-bridge",
      supportsVideo: true,
      maximumCallGroups: "1",
      maximumCallsPerCallGroup: "1",
    },
    android: {
      alertTitle: "着信の許可が必要です",
      alertDescription: "依頼を電話として受け取るために設定を許可してください",
      cancelButton: "あとで",
      okButton: "許可する",
      additionalPermissions: [],
      selfManaged: true,
      foregroundService: {
        channelId: "app.eyesbridge.client.calls",
        channelName: "通話中",
        notificationTitle: "通話中",
      },
    },
  });

  RNCallKeep.addEventListener("answerCall", ({ callUUID }) => {
    const requestId = callToRequest.get(callUUID.toLowerCase());
    if (requestId) handlers.onAnswer(requestId);
  });

  RNCallKeep.addEventListener("endCall", ({ callUUID }) => {
    const key = callUUID.toLowerCase();
    const requestId = callToRequest.get(key);
    if (requestId) {
      handlers.onDecline(requestId);
      forget(requestId);
    }
  });

  if (Platform.OS === "android") {
    RNCallKeep.setAvailable(true);
  }

  configured = true;
}

/** 依頼が来た。端末を電話として鳴らす。 */
export function ringIncoming(requestId: string, callerName = "見てほしい人"): string {
  const existing = requestToCall.get(requestId);
  if (existing) return existing;

  const callUUID = Crypto.randomUUID();
  callToRequest.set(callUUID, requestId);
  requestToCall.set(requestId, callUUID);

  RNCallKeep.displayIncomingCall(
    callUUID,
    requestId,       // handle。通知画面に出るので個人情報は入れない
    callerName,
    "generic",
    true,            // hasVideo
  );

  return callUUID;
}

/** 他のボランティアに先を越された。鳴らし続けない。 */
export function stopRinging(requestId: string, reason: "taken" | "cancelled" = "taken") {
  const callUUID = requestToCall.get(requestId);
  if (!callUUID) return;

  // MissedCall にすると履歴に不在着信が残る。
  // 「他の人が対応した」だけなので RemoteEnded で静かに消す。
  RNCallKeep.reportEndCallWithUUID(
    callUUID,
    reason === "taken" ? RNCallKeep.CONSTANTS.END_CALL_REASONS.REMOTE_ENDED
                       : RNCallKeep.CONSTANTS.END_CALL_REASONS.MISSED,
  );
  forget(requestId);
}

/** こちらが取った。CallKit に「繋がった」と伝える。 */
export function markAnswered(requestId: string) {
  const callUUID = requestToCall.get(requestId);
  if (callUUID) RNCallKeep.setCurrentCallActive(callUUID);
}

/** 通話終了。 */
export function endCall(requestId: string) {
  const callUUID = requestToCall.get(requestId);
  if (callUUID) RNCallKeep.endCall(callUUID);
  forget(requestId);
}

function forget(requestId: string) {
  const callUUID = requestToCall.get(requestId);
  if (callUUID) callToRequest.delete(callUUID);
  requestToCall.delete(requestId);
}

// LiveKit への入室情報。トークンは必ずサーバで発行させる。
import { AudioSession } from "@livekit/react-native";
import { supabase } from "./supabase";

export type JoinInfo = {
  token: string;
  url: string;
  roomName: string;
  role: "requester" | "volunteer";
};

export async function fetchJoinInfo(requestId: string): Promise<JoinInfo> {
  const { data, error } = await supabase.functions.invoke("livekit-token", {
    body: { requestId },
  });
  if (error) throw error;
  return data as JoinInfo;
}

/**
 * 通話前後の音声セッション。
 * これを挟まないと iOS でスピーカーに出ず、受話口から小さく鳴る。
 * 端末を対象物に向けている依頼者にとっては致命的になる。
 */
export async function startAudio() {
  await AudioSession.startAudioSession();
}

export async function stopAudio() {
  await AudioSession.stopAudioSession();
}

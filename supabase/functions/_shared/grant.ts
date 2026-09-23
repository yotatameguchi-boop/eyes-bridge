// LiveKit の入室権限を組み立てる。index.ts から切り出してテストできるようにした。
import { TrackSource, type VideoGrant } from "npm:livekit-server-sdk@2";

export type CallRole = "requester" | "volunteer";

export function videoGrantFor(roomName: string, role: CallRole): VideoGrant {
  return {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // 依頼者だけがカメラを出す。ボランティアは声だけ。
    // 「見る側の顔が映らない」ことが依頼者の心理的な敷居を大きく下げる。
    //
    // 文字列ではなく TrackSource の enum で渡すこと。SDK は toJwt() の中で
    // enum を "camera" などに変換しており、文字列を渡すと変換の default 節で
    // TypeError を投げる。型を捨てる esbuild では気づけず、以前は
    // このせいでトークン発行が毎回失敗して誰も通話に入れなかった。
    canPublishSources: role === "requester"
      ? [TrackSource.CAMERA, TrackSource.MICROPHONE]
      : [TrackSource.MICROPHONE],
  };
}

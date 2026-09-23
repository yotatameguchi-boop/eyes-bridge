import { assertEquals } from "jsr:@std/assert@1";
import { AccessToken } from "npm:livekit-server-sdk@2";
import { videoGrantFor } from "../_shared/grant.ts";

async function publishSourcesInJwt(role: "requester" | "volunteer"): Promise<string[]> {
  const token = new AccessToken("devkey", "secret", { identity: "u1" });
  token.addGrant(videoGrantFor("room_x", role));
  const jwt = await token.toJwt(); // 以前はここで TypeError になっていた
  const body = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(body)).video.canPublishSources;
}

Deno.test("依頼者はカメラとマイクを出せる", async () => {
  assertEquals(await publishSourcesInJwt("requester"), ["camera", "microphone"]);
});

Deno.test("ボランティアはマイクしか出せない（カメラはサーバ側で封じる）", async () => {
  assertEquals(await publishSourcesInJwt("volunteer"), ["microphone"]);
});

Deno.test("入室できる部屋はその依頼の部屋だけ", () => {
  assertEquals(videoGrantFor("room_x", "volunteer").room, "room_x");
});

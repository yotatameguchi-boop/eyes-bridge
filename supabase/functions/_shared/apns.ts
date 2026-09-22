// iOS の VoIP push（PushKit）送信。
//
// なぜ Expo push では駄目か:
//   CallKit で「電話として鳴らす」には PushKit 経由の VoIP push が要る。
//   Expo / FCM の通常通知では、アプリが終了している状態から
//   着信画面を立ち上げられない。通知が1枚出るだけになる。
//   ボランティアが気づかなければ依頼者は誰にも繋がらないので、
//   ここだけは自前で APNs を叩く。

let cachedJwt: { token: string; issuedAt: number } | null = null;

async function importKey(p8: string): Promise<CryptoKey> {
  const body = p8
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (obj: unknown) =>
  b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** APNs のプロバイダトークン。Apple の指定で最長60分、最短20分間隔での再発行。 */
async function providerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 45 * 60) return cachedJwt.token;

  const keyId = Deno.env.get("APNS_KEY_ID")!;
  const teamId = Deno.env.get("APNS_TEAM_ID")!;
  const key = await importKey(Deno.env.get("APNS_PRIVATE_KEY")!);

  const header = b64urlJson({ alg: "ES256", kid: keyId });
  const payload = b64urlJson({ iss: teamId, iat: now });
  const signingInput = `${header}.${payload}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const token = `${signingInput}.${b64url(new Uint8Array(signature))}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

export type VoipPayload = {
  requestId: string;
  roomName: string;
  callerName: string;
  language: string;
};

export async function sendVoipPush(deviceToken: string, payload: VoipPayload): Promise<boolean> {
  const host = Deno.env.get("APNS_HOST") ?? "https://api.push.apple.com";
  const topic = `${Deno.env.get("APNS_BUNDLE_ID")}.voip`;

  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await providerToken()}`,
      "apns-topic": topic,
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 60), // 1分で消える。古い依頼で鳴らさない
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("APNs rejected", res.status, await res.text());
    return false;
  }
  return true;
}

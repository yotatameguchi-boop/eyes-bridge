// APNs のプロバイダトークン（ES256 の JWT）が Apple の求める形になっているか。
// 実際の鍵の代わりにその場で P-256 の鍵を作って、署名を公開鍵で検証する。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { providerToken, resetProviderTokenCache } from "../_shared/apns.ts";

const b64urlDecode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function setUpKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
  Deno.env.set("APNS_PRIVATE_KEY", pem);
  Deno.env.set("APNS_KEY_ID", "KEYID12345");
  Deno.env.set("APNS_TEAM_ID", "TEAMID6789");
  resetProviderTokenCache();
  return pair.publicKey;
}

Deno.test("ヘッダは ES256 と鍵 ID、ペイロードはチーム ID と発行時刻", async () => {
  await setUpKey();
  const [header, payload] = (await providerToken()).split(".");
  assertEquals(JSON.parse(new TextDecoder().decode(b64urlDecode(header))), { alg: "ES256", kid: "KEYID12345" });

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  assertEquals(claims.iss, "TEAMID6789");
  assert(Math.abs(claims.iat - Date.now() / 1000) < 5, "iat は今の時刻");
});

Deno.test("署名が公開鍵で検証できる（JWT が要求する 64 バイトの r||s 形式）", async () => {
  const publicKey = await setUpKey();
  const [header, payload, signature] = (await providerToken()).split(".");
  const raw = b64urlDecode(signature);
  assertEquals(raw.length, 64);

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    raw,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert(valid, "署名が通らない");
});

Deno.test("同じトークンを使い回す（Apple は20分未満の再発行を嫌う）", async () => {
  await setUpKey();
  assertEquals(await providerToken(), await providerToken());
});

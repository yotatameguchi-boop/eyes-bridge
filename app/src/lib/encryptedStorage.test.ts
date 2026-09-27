import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createEncryptedStorage, utf8Decode, utf8Encode, type Cipher } from "./encryptedStorage.ts";

// expo-crypto の代わりに、Node の AES-GCM で同じ形（iv + 暗号文 + タグ の base64）を作る
const cipher: Cipher = {
  async newKey() {
    return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("hex");
  },
  async seal(plain, key) {
    const k = await webcrypto.subtle.importKey("raw", Buffer.from(key, "hex"), "AES-GCM", false, ["encrypt"]);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k, plain));
    return Buffer.concat([iv, body]).toString("base64");
  },
  async open(sealed, key) {
    const k = await webcrypto.subtle.importKey("raw", Buffer.from(key, "hex"), "AES-GCM", false, ["decrypt"]);
    const all = Buffer.from(sealed, "base64");
    return new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: all.subarray(0, 12) }, k, all.subarray(12)));
  },
};

function stores() {
  const secure = new Map<string, string>();
  const plain = new Map<string, string>();
  return {
    secure,
    plain,
    storage: createEncryptedStorage(
      {
        getItemAsync: async (k) => secure.get(k) ?? null,
        setItemAsync: async (k, v) => void secure.set(k, v),
        deleteItemAsync: async (k) => void secure.delete(k),
      },
      {
        getItem: async (k) => plain.get(k) ?? null,
        setItem: async (k, v) => void plain.set(k, v),
        removeItem: async (k) => void plain.delete(k),
      },
      cipher,
    ),
  };
}

const KEY = "sb-127-auth-token";
const SESSION = JSON.stringify({
  access_token: "eyJ.access",
  refresh_token: "refresh-secret",
  user: { email: "a@example.test", user_metadata: { name: "見本 花子 👀" } },
});

test("保存したログイン情報をそのまま読み戻せる（日本語や絵文字を含んでも）", async () => {
  const { storage } = stores();
  await storage.setItem(KEY, SESSION);
  assert.equal(await storage.getItem(KEY), SESSION);
});

test("AsyncStorage には平文を置かない。鍵はキーチェーンにだけある", async () => {
  const { storage, plain, secure } = stores();
  await storage.setItem(KEY, SESSION);
  const stored = plain.get(KEY)!;
  assert.ok(!stored.includes("refresh-secret"));
  assert.ok(!Buffer.from(stored, "base64").toString("utf8").includes("refresh-secret"));
  assert.ok(![...plain.values()].some((v) => v === [...secure.values()][0]), "鍵が AsyncStorage に無い");
  assert.equal(secure.size, 1);
  assert.match([...secure.keys()][0], /^[A-Za-z0-9._-]+$/, "キーチェーンに使える名前");
});

test("書き換えられた暗号文は読まず、ログインしていない扱いにして両方消す", async () => {
  const { storage, plain, secure } = stores();
  await storage.setItem(KEY, SESSION);
  const bytes = Buffer.from(plain.get(KEY)!, "base64");
  bytes[bytes.length - 20] ^= 1;
  plain.set(KEY, bytes.toString("base64"));
  assert.equal(await storage.getItem(KEY), null);
  assert.equal(plain.size, 0);
  assert.equal(secure.size, 0);
});

test("鍵が無ければ（別の端末に移した・キーチェーンが消えた）ログインしていない扱い", async () => {
  const { storage, plain, secure } = stores();
  await storage.setItem(KEY, SESSION);
  secure.clear();
  assert.equal(await storage.getItem(KEY), null);
  assert.equal(plain.size, 0);
});

test("暗号化する前の版の平文は、読んだときに暗号化し直す（ログアウトさせない）", async () => {
  const { storage, plain } = stores();
  plain.set(KEY, SESSION);
  assert.equal(await storage.getItem(KEY), SESSION);
  assert.ok(!plain.get(KEY)!.includes("refresh-secret"));
  assert.equal(await storage.getItem(KEY), SESSION);
});

test("ログアウトすると、暗号文も鍵も消える", async () => {
  const { storage, plain, secure } = stores();
  await storage.setItem(KEY, SESSION);
  await storage.removeItem(KEY);
  assert.equal(plain.size, 0);
  assert.equal(secure.size, 0);
  assert.equal(await storage.getItem(KEY), null);
});

test("書くたびに鍵を作り直す", async () => {
  const { storage, secure } = stores();
  await storage.setItem(KEY, SESSION);
  const first = [...secure.values()][0];
  await storage.setItem(KEY, SESSION);
  assert.notEqual([...secure.values()][0], first);
});

test("UTF-8 の変換は TextEncoder / TextDecoder と同じ結果になる", () => {
  const text = "abc 日本語 é 👀 \u{10FFFF}";
  assert.deepEqual(utf8Encode(text), new TextEncoder().encode(text));
  assert.equal(utf8Decode(new TextEncoder().encode(text)), text);
});

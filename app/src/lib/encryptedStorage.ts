// ログイン情報を暗号化して保存する。
//
// 以前は Supabase のログイン情報（アクセストークンと、何か月も使えるリフレッシュトークン）を
// AsyncStorage にそのまま置いていた。AsyncStorage は暗号化されないので、端末のバックアップや
// 脱獄・root 化した端末から読まれると、その人になりすまして本人確認書類の状態や
// 通話の依頼に触れられる。
//
// キーチェーン（SecureStore）は1項目 2KB 程度までしか置けず、ログイン情報は収まらない。
// そこで Supabase が勧める形にする:
//   * 鍵（AES-256）だけをキーチェーンに置く
//   * AES-GCM で暗号化したログイン情報を AsyncStorage に置く
// GCM は改ざんも検知する。読めなかったら「ログインしていない」として扱い、両方消す。
//
// 実際の SecureStore / AsyncStorage / expo-crypto は supabase.ts で渡す。
// ここは Node のテストで動かせるよう、依存を受け取る形にしている。

export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export type PlainStoreLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type Cipher = {
  /** 新しい鍵を作り、キーチェーンに置ける文字列で返す */
  newKey(): Promise<string>;
  /** 暗号化して、iv・暗号文・タグをまとめた base64 で返す */
  seal(plain: Uint8Array, key: string): Promise<string>;
  /** seal の逆。改ざんされていたら例外 */
  open(sealed: string, key: string): Promise<Uint8Array>;
};

// キーチェーンの項目名に使える文字は英数字と . - _ だけ
function keyName(storageKey: string): string {
  return `${storageKey.replace(/[^A-Za-z0-9._-]/g, "_")}.key`;
}

export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(bytes);
}

// Hermes の版によっては TextDecoder が無いので、自前で戻す
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c: number;
    if (b < 0x80) { c = b; i += 1; }
    else if (b < 0xe0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else {
      c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      i += 4;
    }
    out += String.fromCodePoint(c);
  }
  return out;
}

export function createEncryptedStorage(secure: SecureStoreLike, plain: PlainStoreLike, cipher: Cipher) {
  async function forget(key: string) {
    await plain.removeItem(key);
    await secure.deleteItemAsync(keyName(key));
  }

  async function write(key: string, value: string) {
    // 書くたびに鍵を作り直す（同じ鍵で使い回さない）
    const secret = await cipher.newKey();
    const sealed = await cipher.seal(utf8Encode(value), secret);
    await secure.setItemAsync(keyName(key), secret);
    await plain.setItem(key, sealed);
  }

  return {
    async getItem(key: string): Promise<string | null> {
      const stored = await plain.getItem(key);
      if (stored === null) return null;

      // 暗号化する前の版で保存された、平文のログイン情報。暗号化し直してから返す
      if (stored.startsWith("{")) {
        await write(key, stored);
        return stored;
      }

      const secret = await secure.getItemAsync(keyName(key));
      if (secret === null) {
        await forget(key);
        return null;
      }
      try {
        return utf8Decode(await cipher.open(stored, secret));
      } catch {
        // 改ざんされた・鍵と合わない。ログインし直してもらう
        await forget(key);
        return null;
      }
    },
    setItem: write,
    removeItem: forget,
  };
}

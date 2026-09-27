import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createEncryptedStorage } from "./encryptedStorage";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

// ログイン情報は暗号化して置く（encryptedStorage.ts を参照）。
// 鍵は「端末を一度ロック解除したあと」なら読める設定にする。着信はロック中の
// 画面から取るので、解除中しか読めない設定だと、応答した瞬間にログインが切れる。
// THIS_DEVICE_ONLY なので、バックアップから別の端末へは移らない。
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const sessionStorage = createEncryptedStorage(
  {
    getItemAsync: (key) => SecureStore.getItemAsync(key, keychain),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, keychain),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, keychain),
  },
  AsyncStorage,
  {
    newKey: async () => (await AESEncryptionKey.generate()).encoded("hex"),
    seal: async (plain, key) =>
      (await aesEncryptAsync(plain, await AESEncryptionKey.import(key, "hex"))).combined("base64"),
    open: async (sealed, key) =>
      aesDecryptAsync(AESSealedData.fromCombined(sealed), await AESEncryptionKey.import(key, "hex")),
  },
);

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: sessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    // RN には URL バーが無いので、マジックリンクは Linking から自分で流し込む
    detectSessionInUrl: false,
  },
  realtime: {
    // 待機列は「今すぐ」でないと意味が無い。既定より速く流す。
    params: { eventsPerSecond: 20 },
  },
});

export type RequestState = "queued" | "active" | "completed" | "cancelled" | "timed_out";

export type HelpRequest = {
  id: string;
  requester_id: string;
  volunteer_id: string | null;
  state: RequestState;
  language: string;
  room_name: string;
  created_at: string;
  matched_at: string | null;
  ended_at: string | null;
};

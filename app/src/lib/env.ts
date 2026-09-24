const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`環境変数 ${name} が未設定です。app/.env を確認してください。`);
  return value;
};

export const SUPABASE_URL = required(
  "EXPO_PUBLIC_SUPABASE_URL",
  process.env.EXPO_PUBLIC_SUPABASE_URL,
);

export const SUPABASE_ANON_KEY = required(
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

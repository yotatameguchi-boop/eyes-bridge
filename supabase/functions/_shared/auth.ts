// 呼び出し元の Supabase JWT を検証し、その人として DB を触れるクライアントを返す。
// service-role キーはここでは使わない。使うのは push 送信のときだけ（ring-volunteers 参照）。
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Caller = { userId: string; db: SupabaseClient };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function authenticate(req: Request): Promise<Caller> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "MISSING_BEARER_TOKEN");
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "INVALID_TOKEN");

  return { userId: data.user.id, db };
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** ハンドラを包んで、CORS プリフライトと HttpError を一箇所で処理する。 */
export function serveJson(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "INTERNAL_ERROR" }, 500);
    }
  };
}

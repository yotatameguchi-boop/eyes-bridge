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
      // 断るときも、読み残した本文は受け取ってから返す（drainBody を参照）
      await drainBody(req.body);
      // 500 は中身を返さない。DB のエラー文（表や列の名前、制約名）が
      // そのまま利用者に見えていた。詳細はログにだけ残す
      if (e instanceof HttpError && e.status !== 500) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "INTERNAL_ERROR" }, 500);
    }
  };
}

/**
 * 秘密の値を一定時間で比べる。
 * `===` は先頭から何文字合っているかで時間が変わり、応答時間を測れば当てられる。
 */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  // 長さが違えば違う（長さは秘密ではない）。それでも同じだけ回して時間を揃える
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

/**
 * 読み残した本文を読み捨てる。
 *
 * 本文を読み切らずに返事をすると、手前の中継（ゲートウェイ）が本文を送り続けようとして
 * 詰まり、利用者には 60秒後に 504 が返っていた（回数の上限に達した人が
 * 普通の写真を送っても起きる）。断るときも本文は受け取ってから返す。
 * 際限なく読むことはしない。上限を超えたら諦める（その接続は相手の問題）。
 */
export async function drainBody(body: ReadableStream<Uint8Array> | null, cap = 64 * 1024 * 1024) {
  if (!body || body.locked) return;
  await drainReader(body.getReader(), cap);
}

async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>, cap: number) {
  let seen = 0;
  try {
    while (seen <= cap) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
    }
    await reader.cancel();
  } catch {
    // 相手が切った。読むものは無い
  }
}

/**
 * 本文を流しながら数え、上限を超えたところで止める。
 * Content-Length は送る側が書くもので、書かなければ（chunked）いくらでも流せた。
 *
 * 上限を超えたら、渡し先には止めたことを伝えるが、元の本文は `drain()` で読み捨てられるよう
 * 残しておく（pipeThrough だと元の本文ごと取り消されて、上の詰まりが起きる）。
 */
export function limitBytes(body: ReadableStream<Uint8Array>, max: number) {
  const reader = body.getReader();
  let seen = 0;
  let exceeded = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      seen += value.byteLength;
      if (seen > max) {
        exceeded = true;
        controller.error(new HttpError(413, "IMAGE_TOO_LARGE"));
        return;
      }
      controller.enqueue(value);
    },
    // 渡し先が途中でやめても、元の本文は取り消さない（drain で読み捨てる）
    cancel() {},
  });
  return {
    stream,
    exceeded: () => exceeded,
    drain: () => drainReader(reader, 64 * 1024 * 1024),
  };
}

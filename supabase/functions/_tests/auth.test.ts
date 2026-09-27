import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { drainBody, HttpError, limitBytes, safeEqual, serveJson } from "../_shared/auth.ts";

Deno.test("safeEqual: 同じ値だけを同じとみなす", () => {
  assert(safeEqual("Bearer abc", "Bearer abc"));
  assert(!safeEqual("Bearer abc", "Bearer abd"));
  assert(!safeEqual("Bearer ab", "Bearer abc"));
  assert(!safeEqual("", "Bearer abc"));
  assert(!safeEqual("Bearer abc", ""));
  assert(safeEqual("", ""));
});

function streamOf(sizes: number[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of sizes) c.enqueue(new Uint8Array(n));
      c.close();
    },
  });
}

Deno.test("limitBytes: 上限までは素通しする", async () => {
  const limited = limitBytes(streamOf([400, 600]), 1000);
  const body = new Uint8Array(await new Response(limited.stream).arrayBuffer());
  assertEquals(body.byteLength, 1000);
  assert(!limited.exceeded());
});

Deno.test("limitBytes: Content-Length が無くても、上限を超えたら止める", async () => {
  const limited = limitBytes(streamOf([600, 600]), 1000);
  await assertRejects(() => new Response(limited.stream).arrayBuffer());
  assert(limited.exceeded());
});

/** 何バイト読まれたか・取り消されたかを数える本文 */
function countedStream(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= chunks) return c.close();
      state.pulled++;
      c.enqueue(new Uint8Array(size));
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

Deno.test("limitBytes: 止めたあとも、元の本文は取り消さずに最後まで読み捨てられる", async () => {
  // 取り消すと、手前の中継が本文を送り続けようとして詰まる（504 になった）
  const src = countedStream(10, 500);
  const limited = limitBytes(src.stream, 1000);
  await assertRejects(() => new Response(limited.stream).arrayBuffer());
  assert(!src.state.cancelled);
  await limited.drain();
  assertEquals(src.state.pulled, 10);
});

Deno.test("drainBody: 読み捨てるのは上限まで", async () => {
  const src = countedStream(100, 1000);
  await drainBody(src.stream, 10_000);
  assert(src.state.pulled < 100);
  assert(src.state.cancelled);
});

Deno.test("serveJson: 本文を読まずに断っても、本文は読み捨ててから返す", async () => {
  const src = countedStream(5, 1000);
  const handler = serveJson(() => {
    throw new HttpError(429, "RATE_LIMITED");
  });
  const res = await handler(new Request("http://x", { method: "POST", body: src.stream }));
  assertEquals(res.status, 429);
  assertEquals(src.state.pulled, 5);
});

Deno.test("serveJson: 500 のときは中身（DB のエラー文）を返さない", async () => {
  const handler = serveJson(() => {
    throw new HttpError(500, 'duplicate key value violates unique constraint "identity_one_open_per_user"');
  });
  const res = await handler(new Request("http://x", { method: "POST" }));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "INTERNAL_ERROR" });
});

Deno.test("serveJson: 利用者が直せるエラーは、そのまま返す", async () => {
  const handler = serveJson(() => {
    throw new HttpError(413, "IMAGE_TOO_LARGE");
  });
  const res = await handler(new Request("http://x", { method: "POST" }));
  assertEquals(res.status, 413);
  assertEquals(await res.json(), { error: "IMAGE_TOO_LARGE" });
});

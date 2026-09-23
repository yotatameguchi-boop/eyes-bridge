// 読み上げの振り分けのテスト。端末もスクリーンリーダーも要らない。
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeaker, type SpeakerDeps } from "./speaker.ts";

type Log = string[];

function fake(initial: boolean | Promise<boolean>) {
  const log: Log = [];
  let changed: (enabled: boolean) => void = () => {};
  const deps: SpeakerDeps = {
    isScreenReaderEnabled: () => Promise.resolve(initial),
    onScreenReaderChanged: (listener) => { changed = listener; },
    announce: (m) => log.push(`スクリーンリーダー:${m}`),
    speak: (m, rate) => log.push(`アプリの声(${rate}):${m}`),
    stopSpeaking: () => log.push("停止"),
  };
  return { deps, log, toggle: (v: boolean) => changed(v) };
}

const voices = (log: Log) => log.filter((l) => l !== "停止");

test("スクリーンリーダー使用中は、スクリーンリーダーだけが読む（アプリは喋らない）", async () => {
  const { deps, log } = fake(true);
  const s = createSpeaker(deps);
  await s.say("繋がりました");
  assert.deepEqual(voices(log), ["スクリーンリーダー:繋がりました"]);
});

test("スクリーンリーダー未使用なら、アプリの声だけが読む", async () => {
  const { deps, log } = fake(false);
  const s = createSpeaker(deps);
  await s.say("繋がりました");
  assert.deepEqual(voices(log), ["アプリの声(1):繋がりました"]);
});

test("どちらの場合も、1つの知らせは1回しか読まれない", async () => {
  for (const on of [true, false]) {
    const { deps, log } = fake(on);
    const s = createSpeaker(deps);
    await s.say("探しています");
    assert.equal(voices(log).length, 1, `スクリーンリーダー=${on}`);
  }
});

test("判定が終わる前の最初の知らせも、判定を待ってから振り分ける", async () => {
  let resolve!: (v: boolean) => void;
  const { deps, log } = fake(new Promise<boolean>((r) => { resolve = r; }));
  const s = createSpeaker(deps);
  const pending = s.say("起動しました");   // 判定はまだ終わっていない
  assert.deepEqual(voices(log), [], "判定前に喋ってはいけない");
  resolve(true);
  await pending;
  assert.deepEqual(voices(log), ["スクリーンリーダー:起動しました"]);
});

test("途中で VoiceOver を点けたら、流れているアプリの声をその場で止める", async () => {
  const { deps, log, toggle } = fake(false);
  const s = createSpeaker(deps);
  await s.say("読み上げ中");
  log.length = 0;
  toggle(true);
  assert.deepEqual(log, ["停止"]);
  await s.say("次の知らせ");
  assert.deepEqual(voices(log), ["スクリーンリーダー:次の知らせ"]);
});

test("途中で VoiceOver を切ったら、アプリの声に切り替わる", async () => {
  const { deps, log, toggle } = fake(true);
  const s = createSpeaker(deps);
  toggle(false);
  await s.say("次の知らせ");
  assert.deepEqual(voices(log), ["アプリの声(1):次の知らせ"]);
});

test("判定の最中に切り替えがあったら、古い判定結果で上書きしない", async () => {
  let resolve!: (v: boolean) => void;
  const { deps, log, toggle } = fake(new Promise<boolean>((r) => { resolve = r; }));
  const s = createSpeaker(deps);
  toggle(true);          // 利用者が VoiceOver を点けた
  resolve(false);        // その後で、古い「未使用」の判定が返ってきた
  await s.say("知らせ");
  assert.deepEqual(voices(log), ["スクリーンリーダー:知らせ"]);
});

test("長い読み取り結果は、スクリーンリーダー使用中はフォーカスを移して読ませる", async () => {
  const { deps, log } = fake(true);
  const s = createSpeaker(deps);
  let focused = 0;
  const channel = await s.readLong("東京都公安委員会…", () => { focused++; });
  assert.equal(channel, "screen-reader");
  assert.equal(focused, 1);
  assert.deepEqual(voices(log), [], "アプリの声でも読み上げ依頼でも読まない（二重になる）");
});

test("長い読み取り結果は、スクリーンリーダー未使用ならアプリがやや遅めに読む", async () => {
  const { deps, log } = fake(false);
  const s = createSpeaker(deps);
  let focused = 0;
  await s.readLong("東京都公安委員会…", () => { focused++; });
  assert.equal(focused, 0);
  assert.deepEqual(voices(log), ["アプリの声(0.95):東京都公安委員会…"]);
});

test("アプリの声は、読む前に前の読み上げを止める（重ならない）", async () => {
  const { deps, log } = fake(false);
  const s = createSpeaker(deps);
  await s.say("1つ目");
  await s.say("2つ目");
  assert.deepEqual(log, ["停止", "アプリの声(1):1つ目", "停止", "アプリの声(1):2つ目"]);
});

// 規約まわりのテスト。
//   * docs/legal/ が documents.ts と同じか（手で片方だけ直していないか）
//   * アプリの版と DB の版が揃っているか
//     （ずれると、利用者が読んだのと違う版に同意したことになる）
//   * 外してはいけない内容が書いてあるか
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DOCUMENTS, MARKDOWN_FILE, PRIVACY, SENSITIVE, TERMS, toMarkdown } from "./documents.ts";

const root = new URL("../../../", import.meta.url);

test("docs/legal/ が documents.ts と同じ（違うなら npm run legal:docs）", () => {
  for (const doc of Object.values(DOCUMENTS)) {
    const onDisk = readFileSync(new URL(`docs/legal/${MARKDOWN_FILE[doc.id]}`, root), "utf8");
    assert.equal(onDisk, toMarkdown(doc), `${MARKDOWN_FILE[doc.id]} が古い`);
  }
});

test("アプリの文書の版と、DB の current_consent_version() が揃っている", () => {
  // いちばん新しいマイグレーションの定義を使う
  const dir = new URL("supabase/migrations/", root);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let definition = "";
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    const m = sql.match(/function current_consent_version[\s\S]*?\$\$([\s\S]*?)\$\$/);
    if (m) definition = m[1];
  }
  assert.ok(definition, "current_consent_version の定義が見つからない");

  for (const doc of Object.values(DOCUMENTS)) {
    const m = definition.match(new RegExp(`'${doc.id}'\\s+then\\s+'([^']+)'`));
    assert.equal(m?.[1], doc.version, `${doc.id} の版が DB（${m?.[1]}）とアプリ（${doc.version}）で違う`);
  }
});

const fullText = (d: typeof TERMS) =>
  [...d.summary, ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs])].join("\n");

test("規約：緊急時は119、読み上げの正確さは保証しない、が要点に入っている", () => {
  const summary = TERMS.summary.join("\n");
  assert.match(summary, /119/);
  assert.match(summary, /正確さは保証できません/);
});

test("プライバシーポリシー：録画しない・個人番号を取らない・書類画像を消す、が書いてある", () => {
  const text = fullText(PRIVACY);
  assert.match(text, /録画も録音もしません/);
  assert.match(text, /個人番号（マイナンバー）は取得しません/);
  assert.match(text, /承認なら7日後、却下なら30日後/);
});

test("要配慮個人情報：同意しない場合どうなるか（ボランティアでは登録できる）まで要点で言う", () => {
  assert.match(SENSITIVE.summary.join("\n"), /同意しない場合.*読む側で登録することはできます/);
});

test("決めていない箇所が【要記入】【要確認】として残っていることを隠さない", () => {
  // 下書きのまま公開しないための目印。埋めたらこのテストを外す
  assert.match(fullText(TERMS) + fullText(PRIVACY), /【要記入/);
});

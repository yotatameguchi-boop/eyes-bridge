// docs/legal/*.md を app/src/legal/documents.ts から作り直す。
//   npm run legal:docs
import { mkdirSync, writeFileSync } from "node:fs";
import { DOCUMENTS, MARKDOWN_FILE, toMarkdown } from "../src/legal/documents.ts";

const outDir = new URL("../../docs/legal/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const doc of Object.values(DOCUMENTS)) {
  writeFileSync(new URL(MARKDOWN_FILE[doc.id], outDir), toMarkdown(doc));
  console.log(`docs/legal/${MARKDOWN_FILE[doc.id]}（${doc.title} ${doc.version}）`);
}

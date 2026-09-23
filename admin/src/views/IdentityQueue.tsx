import { useCallback, useEffect, useState } from "react";
import {
  FLAG_INFO,
  KIND_LABEL,
  fetchSubmissions,
  reviewIdentity,
  runInspection,
  signedUrl,
  type Submission,
} from "../lib/api";

export function IdentityQueue() {
  const [items, setItems] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchSubmissions("submitted"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="muted">読み込み中…</p>;
  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;

  return (
    <>
      <div className="banner">
        自動チェックは材料であって判定ではありません。
        旗が立っていなくても本物とは限らず、立っていても偽物とは限りません。
        券面の顔写真と自撮りが同一人物かは<strong>自動では見ていません</strong>。必ず目で確かめてください。
      </div>

      {items.length === 0 ? (
        <p className="muted">審査待ちはありません。</p>
      ) : (
        items.map((item) => (
          <SubmissionCard key={item.id} item={item} onDone={load} />
        ))
      )}
    </>
  );
}

function SubmissionCard({ item, onDone }: { item: Submission; onDone: () => void }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const paths: [string, string | null][] = [
        ["表面", item.front_path],
        ["裏面", item.back_path],
        ["自撮り", item.selfie_path],
      ];
      const resolved: Record<string, string | null> = {};
      for (const [label, path] of paths) {
        resolved[label] = path ? await signedUrl(path) : null;
      }
      if (alive) setUrls(resolved);
    })();
    return () => {
      alive = false;
    };
  }, [item.id, item.front_path, item.back_path, item.selfie_path]);

  async function act(approve: boolean) {
    if (!approve && reason.trim().length === 0) {
      setNote("却下する理由を書いてください。本人に表示されます。");
      return;
    }
    setBusy(true);
    try {
      await reviewIdentity(item.id, approve, reason.trim());
      onDone();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    setBusy(true);
    setNote(null);
    try {
      await runInspection(item.id);
      setNote("自動チェックを実行しました。再読み込みで反映されます。");
    } catch {
      setNote("自動チェックを実行できませんでした（OCR サーバの設定を確認）");
    } finally {
      setBusy(false);
    }
  }

  const check = item.check;

  return (
    <div className="card">
      <div className="spread">
        <div>
          <strong>{item.displayName}</strong>
          <div className="muted">
            {KIND_LABEL[item.kind]} ／ 提出 {new Date(item.submitted_at).toLocaleString("ja-JP")}
          </div>
        </div>
        <button onClick={inspect} disabled={busy}>
          {check ? "自動チェックをやり直す" : "自動チェックを実行"}
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        {check === null ? (
          <span className="flag weak">自動チェック未実行</span>
        ) : check.flags.length === 0 ? (
          <span className="flag ok">自動チェックで引っかかった点なし</span>
        ) : (
          check.flags.map((flag) => {
            const info = FLAG_INFO[flag];
            return (
              <span
                key={flag}
                className={`flag ${info?.strength ?? "weak"}`}
                title={info?.note ?? flag}
              >
                {info?.label ?? flag}
              </span>
            );
          })
        )}
      </div>

      {check ? (
        <details style={{ marginTop: 8 }}>
          <summary className="muted">判断の根拠</summary>
          <ul className="muted">
            <li>読めた語: {String((check.details.matched_keywords as string[])?.join("、") || "なし")}</li>
            <li>有効期限: {String(check.details.expiry ?? "読めず")}</li>
            <li>OCR の信頼度: {String(check.details.ocr_confidence ?? "-")}</li>
            <li>
              顔の数: 書類 {String(check.details.faces_in_document ?? "-")} ／
              自撮り {String(check.details.faces_in_selfie ?? "-")}
            </li>
            <li>モアレの強さ: {String(check.details.moire_score ?? "-")}</li>
          </ul>
          {check.flags.map((flag) =>
            FLAG_INFO[flag] ? (
              <p key={flag} className="muted">
                <strong>{FLAG_INFO[flag].label}</strong>：{FLAG_INFO[flag].note}
              </p>
            ) : null,
          )}
        </details>
      ) : null}

      <div className="shots">
        {Object.entries(urls).map(([label, url]) =>
          url ? (
            <figure key={label}>
              <img src={url} alt={`${item.displayName} の${label}`} />
              <figcaption>{label}</figcaption>
            </figure>
          ) : null,
        )}
      </div>

      <div className="stack">
        <label htmlFor={`reason-${item.id}`} className="muted">
          却下する場合の理由（本人に表示されます）
        </label>
        <textarea
          id={`reason-${item.id}`}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例：文字が読み取れません。明るい場所で撮り直してください。"
        />
        <div className="row">
          <button className="primary" onClick={() => act(true)} disabled={busy}>
            承認する
          </button>
          <button className="danger" onClick={() => act(false)} disabled={busy}>
            却下する
          </button>
        </div>
        {note ? <p className="muted">{note}</p> : null}
      </div>
    </div>
  );
}

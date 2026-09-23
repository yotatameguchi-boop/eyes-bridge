import { useCallback, useEffect, useState } from "react";
import { REASON_LABEL, fetchReports, handleReport, type ReportRow } from "../lib/api";

export function Reports() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await fetchReports(onlyOpen));
  }, [onlyOpen]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markHandled(id: string) {
    setBusy(id);
    try {
      await handleReport(id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <label>
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
            style={{ width: "auto", marginRight: 8 }}
          />
          未対応のみ
        </label>
      </div>

      <div className="banner">
        別々の3人から通報が集まると、そのボランティアは自動で停止します。
        ここで「対応済み」にしても停止は解除されません。
        解除するにはボランティア一覧から承認し直してください。
      </div>

      {rows.length === 0 ? (
        <p className="muted">通報はありません。</p>
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="spread">
              <div>
                <strong>{r.reportedName}</strong> への通報
                <div className="muted">
                  {REASON_LABEL[r.reason] ?? r.reason} ／
                  {new Date(r.created_at).toLocaleString("ja-JP")}
                  {r.handled_at ? " ／ 対応済み" : ""}
                </div>
              </div>
              {!r.handled_at ? (
                <button disabled={busy === r.id} onClick={() => markHandled(r.id)}>
                  対応済みにする
                </button>
              ) : null}
            </div>
            {r.detail ? <p style={{ whiteSpace: "pre-wrap" }}>{r.detail}</p> : null}
          </div>
        ))
      )}
    </>
  );
}

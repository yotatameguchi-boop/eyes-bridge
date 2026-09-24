import { useCallback, useEffect, useState } from "react";
import { REASON_LABEL, fetchReports, handleReport, setUserBlocked, type ReportRow } from "../lib/api";

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

  async function toggleBlock(row: ReportRow) {
    setBusy(row.id);
    try {
      await setUserBlocked(row.reported_id, !row.reportedBlocked);
      await load();
    } finally {
      setBusy(null);
    }
  }

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
        別々の3人から通報が集まると、自動で止まります（ボランティアは待機の停止、
        依頼者は利用の停止）。ここで「対応済み」にしても停止は外れません。
        ボランティアはボランティア一覧から承認し直し、依頼者はこの画面の
        「利用停止を外す」で戻してください。依頼者にとって利用停止は
        「助けを呼べなくなる」ことなので、誤って止まっていないか必ず見直してください。
      </div>

      {rows.length === 0 ? (
        <p className="muted">通報はありません。</p>
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="spread">
              <div>
                <strong>{r.reportedName}</strong>
                （{r.reportedRole === "requester" ? "依頼者" : "ボランティア"}）への通報
                {r.reportedBlocked ? <span className="flag hard" style={{ marginLeft: 8 }}>利用停止中</span> : null}
                <div className="muted">
                  {REASON_LABEL[r.reason] ?? r.reason} ／
                  {new Date(r.created_at).toLocaleString("ja-JP")}
                  {r.handled_at ? " ／ 対応済み" : ""}
                </div>
              </div>
              <div className="row">
                {r.reportedRole === "requester" ? (
                  <button
                    className={r.reportedBlocked ? "" : "danger"}
                    disabled={busy === r.id}
                    onClick={() => toggleBlock(r)}
                  >
                    {r.reportedBlocked ? "利用停止を外す" : "利用を止める"}
                  </button>
                ) : null}
                {!r.handled_at ? (
                  <button disabled={busy === r.id} onClick={() => markHandled(r.id)}>
                    対応済みにする
                  </button>
                ) : null}
              </div>
            </div>
            {r.detail ? <p style={{ whiteSpace: "pre-wrap" }}>{r.detail}</p> : null}
          </div>
        ))
      )}
    </>
  );
}

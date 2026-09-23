import { useCallback, useEffect, useState } from "react";
import { fetchVolunteers, reviewVolunteer, type VolunteerRow } from "../lib/api";

const STATE_LABEL: Record<VolunteerRow["review_state"], string> = {
  pending: "審査待ち",
  approved: "承認済み",
  suspended: "停止中",
  rejected: "却下",
};

export function Volunteers() {
  const [rows, setRows] = useState<VolunteerRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await fetchVolunteers());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(userId: string, state: VolunteerRow["review_state"]) {
    setBusy(userId);
    setNote(null);
    try {
      await reviewVolunteer(userId, state);
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setNote(
        message.includes("IDENTITY_NOT_VERIFIED")
          ? "本人確認がまだです。先に書類を承認してください。"
          : "変更できませんでした",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {note ? <div className="banner">{note}</div> : null}
      <table>
        <thead>
          <tr>
            <th>名前</th>
            <th>状態</th>
            <th>本人確認</th>
            <th>規約</th>
            <th>対応数</th>
            <th>待機</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id}>
              <td>{r.displayName}</td>
              <td>{STATE_LABEL[r.review_state]}</td>
              <td>
                {r.identityApproved ? (
                  <span className="flag ok">済</span>
                ) : (
                  <span className="flag soft">未</span>
                )}
              </td>
              <td className="muted">{r.agreed_to_terms_at ? "同意済" : "未同意"}</td>
              <td>{r.accepted_count}</td>
              <td className="muted">{r.is_available ? "待機中" : "—"}</td>
              <td>
                <div className="row">
                  {r.review_state !== "approved" ? (
                    <button
                      className="primary"
                      disabled={busy === r.user_id || !r.identityApproved}
                      title={r.identityApproved ? "" : "本人確認が済んでいません"}
                      onClick={() => act(r.user_id, "approved")}
                    >
                      承認
                    </button>
                  ) : (
                    <button
                      className="danger"
                      disabled={busy === r.user_id}
                      onClick={() => act(r.user_id, "suspended")}
                    >
                      停止
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">ボランティアがいません。</p> : null}
    </>
  );
}

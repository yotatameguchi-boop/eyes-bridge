import { useState } from "react";
import { supabase } from "../lib/supabase";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // 運営アカウントをこの画面から勝手に作れないようにする
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (error) setError("コードを送れませんでした。登録済みのアドレスか確認してください。");
    else setSent(true);
  }

  async function verify() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) setError("コードが違います。");
  }

  return (
    <div className="shell" style={{ maxWidth: 420, paddingTop: 80 }}>
      <h1>eyes-bridge 運営</h1>
      <div className="card stack">
        {!sent ? (
          <>
            <label htmlFor="email">メールアドレス</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <button className="primary" onClick={send} disabled={busy || !email.trim()}>
              {busy ? "送信中" : "コードを送る"}
            </button>
          </>
        ) : (
          <>
            <label htmlFor="code">メールに届いた6桁のコード</label>
            <input
              id="code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
            <button className="primary" onClick={verify} disabled={busy || code.trim().length < 6}>
              {busy ? "確認中" : "ログイン"}
            </button>
            <button onClick={() => { setSent(false); setCode(""); }}>入れ直す</button>
          </>
        )}
        {error ? <p style={{ color: "var(--danger)" }} role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

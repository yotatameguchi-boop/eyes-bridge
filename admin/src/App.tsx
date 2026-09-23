import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { isAdmin } from "./lib/api";
import { SignIn } from "./views/SignIn";
import { IdentityQueue } from "./views/IdentityQueue";
import { Volunteers } from "./views/Volunteers";
import { Reports } from "./views/Reports";

type Tab = "identity" | "volunteers" | "reports";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("identity");

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setAdmin(null);
      return;
    }
    void isAdmin().then(setAdmin);
  }, [session?.user?.id]);

  if (!session) return <SignIn />;

  if (admin === null) return <div className="shell"><p className="muted">確認中…</p></div>;

  // 画面を隠すのは親切であって守りではない。
  // 実際の防御は RLS と is_admin を見る RPC 側にある。
  if (!admin) {
    return (
      <div className="shell">
        <h1>eyes-bridge 運営</h1>
        <div className="banner">このアカウントには運営権限がありません。</div>
        <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="spread">
        <h1>eyes-bridge 運営</h1>
        <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </div>

      <nav className="tabs">
        <button aria-current={tab === "identity"} onClick={() => setTab("identity")}>
          本人確認
        </button>
        <button aria-current={tab === "volunteers"} onClick={() => setTab("volunteers")}>
          ボランティア
        </button>
        <button aria-current={tab === "reports"} onClick={() => setTab("reports")}>
          通報
        </button>
      </nav>

      {tab === "identity" ? <IdentityQueue /> : null}
      {tab === "volunteers" ? <Volunteers /> : null}
      {tab === "reports" ? <Reports /> : null}
    </div>
  );
}

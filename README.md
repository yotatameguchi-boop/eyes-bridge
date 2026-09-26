# eyes-bridge

目が見えない・見えにくい人が、目の前の文字を見える人に読んでもらうためのアプリ。
押すと、待機中のボランティア1人と1対1の通話で繋がる。人が捕まらない時間帯は、その場で機械が読み上げる。

## 構成

```
RN（callkeep + PushKit で OS の着信画面）
  ├ 通話: LiveKit（Cloud → 必要になったら自前 SFU）
  ├ 待機列: Supabase Realtime Presence + Postgres
  └ AI経路: 端末内 TTS（expo-speech）+ サーバ側 PaddleOCR
```

| ディレクトリ | 中身 |
|---|---|
| `app/` | React Native (Expo SDK 57 / dev client)。依頼者とボランティアの両方 |
| `supabase/migrations/` | スキーマ・RLS・取り合いを解決する RPC・審査と通報 |
| `supabase/functions/` | LiveKit トークン発行、待機者への一斉着信（APNs VoIP / Expo push） |
| `supabase/tests/` | マイグレーションを実 Postgres に当てて安全側の挙動を検証する |
| `admin/` | 運営画面（Vite + React）。本人確認の審査・ボランティア管理・通報対応 |
| `ocr/` | FastAPI + PaddleOCR。読み上げと、本人確認書類の自動チェック |
| `docker/`, `docker-compose.yml` | 手元で DB / LiveKit / OCR を立てる |

## 設計で効いている判断

**取り合いは DB の単一 UPDATE で決める。**
`claim_help_request` が `UPDATE ... WHERE state = 'queued'` を1文で撃つ。同時に5人が「受ける」を押しても、
`RETURNING` が返るのは1人だけ。アプリ側のロックも順番待ちも要らない。
負けた4人には `ALREADY_TAKEN` が返るが、これはエラーではなく「誰かが対応できた」という通常の分岐として扱う。

**依頼は1人ずつではなく全員に鳴らす。**
順番待ちにすると、夜間の在席率が低い時間帯に依頼者が数十秒待たされる。
待機中の全員（上限50人）を同時に鳴らし、最初に取った人が勝つ。

**ボランティアのカメラは映さない。**
LiveKit のトークン発行時に `canPublishSources` を依頼者だけ `camera` にしている。
サーバ側で権限を絞っているので、クライアントを改造しても映せない。
「見てもらう側の顔が映らない」ことが、依頼のハードルを実際に下げる。

**状態変化は「声1回＋振動」で伝える。声は利用者の聞き方で出し分ける。**
スクリーンリーダー（VoiceOver / TalkBack）を使っている人にはその声と速さで、
使っていない人にはアプリ自身の声で読む。両方を出すと同じ文が2つの声で重なる
（以前はそうなっていた）。振り分けは `app/src/lib/speaker.ts` にまとめてあり、
端末なしで `npm test`（app/）で確かめられる。
長い読み取り結果は、スクリーンリーダー使用中はその文章にフォーカスを移して読ませる。
利用者が自分の操作で何度でも聞き直せるように。

**OCR の信頼度をそのままアプリまで返す。**
黙って間違った金額や用量を読み上げるのが一番危ない。
信頼度 0.6 未満の行が混じったら「はっきり読めない部分があります」と先に言う。

**撮り方がまずければ、どう撮り直すかを声で言う。**
目が見えない人は、紙が画面に入っているかを確かめられない。
「文字が見つかりませんでした」だけでは直しようがないので、撮った写真の
写り方から原因を1つに絞り、スマホをどちらに動かすかまで言う。

| 写り方 | 言うこと |
|---|---|
| 画面の端が文字の途中を通っている | 「右側が切れています。スマホを少し右へずらすか、少し離して…」 |
| 端のすぐ手前まで文字がある | 「下にも続きがあるかもしれません」（推測なので撮り直しは勧めない） |
| 文字が大きく写って端に掛かる | 「近すぎて、紙がはみ出しています。少し離して…」 |
| 1行も読めず、ぼけている | 「ぼやけていて読めません。両手で持ち、動かさないように…」 |
| 1行も読めず、何も写っていない | 「文字が見つかりませんでした。スマホを紙の真上に、30センチほど…」 |

* **読めたのなら口を出さない。** 暗くても文字が小さくても、読めていれば撮り直させない
* **方向は「スマホを構えている向き」で言う。** OCR は横向きの写真を起こしてから読み、
  座標も起こした後の向きで返す。そのまま使うと、横向きに撮った写真で逆の方向を
  言ってしまうので、サーバ側で撮ったときの向きに戻している（`ocr/framing.py`）
* **案内と本文は1つの読み上げにまとめる。** 案内のあとに「読めたところを読みます」と
  続けて本文を読む。撮り直すかどうかは本人が決める
* **閾値は本物の OCR の出力から決めた。** 最初に思い込みで決めた案は5か所外れていた
  （例：横向きの写真では行の「高さ」が行の長さになるので、文字の大きさは行の太さで測る）。
  実際の出力を `app/src/lib/__fixtures__/` に置いてテストしている

判断は `app/src/lib/framing.ts`（React Native に依存しない）にある。
いまは撮った後に1回判断しているが、将来「撮る前に」案内するライブ方式にしたときも、
端末内の文字検出の結果を同じ形で渡せばそのまま使える。

**画像もテキストも保存しない。**
DB に持つのは「誰が・いつ・何秒繋がったか」と通報だけ。依頼の本文も、映像も、OCR 結果も残さない。
薬袋・請求書・診断書が飛んでくる前提なので、保存した瞬間にそこが漏洩面になる。

## 安全側の作り

他人のカメラ映像が流れる以上、ここが本体と言っていい。

**待機できるまでの関門は3つ。** 規約への同意 → 本人確認 → 運営の承認。
順番は入れ替えない。本人確認を先に求めると、何のために書類を出すのか
分からないまま免許証を撮らせることになる。

**審査を通るまで待機列が見えない。**
ボランティアは登録直後 `pending`。3つの関門を全部通るまで、
待機中の依頼は RLS で1行も返らない。通知も飛ばない。

**個人番号（マイナンバー）は保存しない。**
番号法20条により、個人番号の収集・保管は社会保障・税・災害対策の事務に限られる。
ボランティアのマッチングはどれにも当たらないので、取得した時点で違法になる。
マイナンバーカードは本人確認書類としては使えるため、**表面だけを受け取り、
個人番号が印字された裏面はアプリ側でも DB 制約でも拒否する**。
免許証番号などの書類番号も保存しない。要るのは「本人かどうか」であって番号ではなく、
持たなければ漏れない。

**本人確認が済むまでボランティアを承認できない。**
`review_volunteer(..., 'approved')` は本人確認済みでないと `IDENTITY_NOT_VERIFIED` で弾く。
ただし `suspended` / `rejected` は本人確認なしでも通す。問題が起きたときに
止められないと本末転倒なので。

**自動チェックは材料であって判定ではない。**
書類の真贋を機械が断定できる前提で作ると、見逃したときに誰も気づかない仕組みになる。
`ocr/inspection.py` が出すのは旗（flag）だけで、承認・却下を決めるのは人。
運営画面では旗ごとに「これ単独で却下していいか」を hard / soft / weak で示している。

見ているもの:

| 旗 | 強さ | 意味 |
|---|---|---|
| `expired` | hard | 券面から読んだ有効期限が過去 |
| `unreadable` | hard | 暗い・ぶれ・小さい。偽造以前に審査できない |
| `keywords_missing` | soft | その書類にあるはずの語が1つも無い |
| `duplicate_document` | soft | 同じ人の書類（氏名と生年月日が一致）が別のアカウントでも使われている |
| `no_face_in_document` | soft | 顔写真のある面を撮っていない疑い |
| `possible_screen_capture` | weak | モアレが強い。布や網戸ごしでも上がる |
| `expiry_not_found` | weak | 期限を読めなかった。記載位置は書類ごとに違う |
| `fingerprint_unavailable` | weak | 氏名か生年月日を読めず、使い回しを確かめられなかった |
| `from_suspended_account` | hard | 利用停止になって退会した人と同じ書類 |
| `reused_after_deletion` | soft | 退会した人と同じ書類（本人が戻ってきただけのことが多い） |

**使い回しの検出は、券面の氏名と生年月日から作る「書類の識別子」で行う。**
OCR サーバが、券面から読んだ氏名と生年月日を、サーバだけが持つ鍵（`FINGERPRINT_KEY`）で
HMAC にして返し、別のアカウントの書類と完全一致で照合する。同じ人の書類なら撮り直しても一致し、
別人なら一致しない。氏名と生年月日そのものはどこにも残らず、鍵が無ければ総当たりでも戻せない。
画像を消したあとも識別子は残せる。本物の免許証を家族から借りている場合もここに出る。

以前は券面画像の知覚ハッシュ（pHash）のハミング距離で比べていたが、
**様式が同じ免許証は別人どうしでも距離が 2〜6 になり、ほぼすべてを使い回しと誤判定していた**
（見本画像で確かめた）。pHash が捉えるのは「見た目の様式」で「誰の書類か」ではないため。
鍵は一度決めたら変えない（変えると、それまでの書類と照合できなくなる）。

**やっていないこと。**
券面の顔写真と自撮りが同一人物かの照合は**していない**。
生体データの保存を伴うため、入れるなら同意の取り方と取り扱いを別途設計する必要がある。
ホログラム・透かし・券面の材質の検証も、平面の写真からは原理的に見えないのでやらない。
どちらも人が目で見る前提。

**書類の画像は審査が済んだら消す。**
承認なら7日、却下なら30日（問い合わせに答えるため）で `purge_after` が立ち、
`purge-identity-documents` が Storage から実体を消す。
消えるのは画像だけで、「いつ誰が承認したか」は残す。辿れなくなると困るため。

**自己承認を列権限で封じている。**
RLS は「どの行を触れるか」しか制御しないので、「自分の待機状態は更新できる」ポリシーがある限り
`review_state = 'approved'` を自分で書き込めてしまう。
`volunteer_status` と `profiles` は `revoke insert, update` してから列単位で grant し直し、
審査に関わる列（`review_state` / `is_admin` / `is_blocked`）はサーバ側の security definer 関数からしか動かせない。

**通報は通話直後にしか出さない。**
設定の奥に置くと、嫌な思いをした人ほど辿り着けない。通話が終わると必ず一度この画面を通る。
相手が誰かはサーバが通話記録から決める。クライアントに `reported_id` を選ばせると、
無関係な人を通報できてしまうため。

**ブロックは双方向に効く。**
片方向だと、通報された側が相手を選んで取り続けられる。`blocked_between()` が
どちらの向きのブロックも見て、`claim_help_request` と RLS と着信送信の3か所で弾く。

**アカウントを作っただけで悪用できないようにする。**
誰でも登録できるので、1アカウントで何ができるかを DB 側で絞っている
（`0009_abuse_limits.sql`）。以前はスクリプト1本で、待機中のボランティア最大50人の
スマホを着信画面で延々と鳴らせた。

* 依頼の表は直接書き換えられない。作るときに書けるのは「誰の依頼か」と言語だけで、
  作成時刻・部屋名・状態はサーバが決める（作成時刻を書かせると上限をすり抜けられる）
* 未処理の依頼は1人1件、10分に6件・1日40件まで。撮り直しや再依頼を妨げない程度に緩く取ってある。
  アプリが落ちて依頼が残った場合は、アプリが自分の待っている依頼を取り下げてから立て直す
* 着信は1依頼につき1回。「鳴らした」印を DB で1回だけ付けるので、同時に呼ばれても鳴るのは1回
* 読み取りは10分に30回まで

**別々の3人から通報されると自動で停止する。**
ボランティアは待機を止め、依頼者は利用を止める（以前は依頼者は何人から通報されても
止まらなかった）。依頼者にとって利用停止は「助けを呼べなくなる」ことなので、
運営画面の通報一覧から見直して外せるようにしてある。
1人が連打しても止まらないよう、`count(distinct reporter_id)` で数える。

**命に関わるときは119へ、と必ず伝える。**
薬の飲み間違い・火災報知器・ガス漏れなどで、このアプリが使われる場面は必ずある。
依頼者のホーム画面の最後に常に案内を置き（毎回声に出すと日常の操作の邪魔になるので、
なぞれば必ず行き当たる位置に置く）、ボランティアには通話中の画面と、同意する規約の
両方で「すぐに119に電話するよう伝える。自分で解決しようとしない」と示す。

**薬を読むときは、先に「人にも確かめて」と言う。**
OCR は自信満々で読み間違えることがあり、自信の低い行への警告だけでは防げない。
読み取った文が薬の説明らしいとき（「用法」「服用」や、「2錠」と「食後」の組み合わせなど）は、
本文より先に「飲む量や回数は、薬剤師か家族にも確かめてください」と言う。
判定は緩めにしてある（薬なのに言わないほうが、言い過ぎより危ないため）。
ボランティアの規約にも「数字を一つずつはっきり読む。飲むかどうかの判断や助言はしない」を入れた。

**ボランティアの端末では、通話中の画面録画とスクリーンショットを止める。**
映るのは通帳や診断書かもしれない。Android は録画・スクショとも、iOS は録画（11以降）と
スクショ（13以降）を防ぐ（`expo-screen-capture`）。別のスマホで画面を撮られることまでは防げない。

**「見えにくさがある」という情報は、同意の後でしか取得しない。**
「読んでもらう側」として登録することは、視覚の障害・見えにくさがある可能性を示す。
個人情報保護法では、障害に関する情報は要配慮個人情報に当たり、取得には本人の事前の同意が要る。
以前は役割を選んだ瞬間に保存していた（同意の前に取得していた）。

* 役割を選ぶ画面では何も保存しない。次の同意の画面で、同意と役割の保存を
  `register_role` が1つの処理で行う。依頼者なら要配慮個人情報への同意が無いと DB が断る
* 役割は profiles に直接書けない（列権限）。どの経路でも同意を飛ばせない
* 文書の版が上がったら、同意し直すまで依頼を立てられない・受けられない
* 同意の画面はスクリーンリーダーで聞く前提で作った。各文書は要点を先に置き、全文は開いたときだけ。
  同意ボタンの名前に「同意して、読んでもらう側で登録する」と、何が起きるかまで入れた

**利用規約・プライバシーポリシー・要配慮個人情報への同意文（下書き）**:
[docs/legal/](docs/legal/)。本文は `app/src/legal/documents.ts` が唯一の元で、docs/ はそこから作る
（`cd app && npm run legal:docs`）。アプリの版と DB の版（`current_consent_version()`）が揃っているかは
テストで確かめている。**【要記入】【要確認】は運営者が決める箇所**で、公開前に必ず専門家の確認が要る。

**アプリからいつでも退会でき、そのときにデータを消す。**
アカウント・役割・依頼の記録・通報・ブロック・同意の記録・書類の画像を消す（`delete-account`）。
不正な作り直しを防ぐため、**書類の識別子（元に戻せない）と「利用停止されていたか」だけは残す**
（プライバシーポリシーに記載）。これだけでは、その人が誰かは分からない。
退会した人の書類で作り直すと運営画面に旗が立ち、利用停止されていた人なら強い旗
（`from_suspended_account`）にする。残さないと、止められた人が退会して同じ書類で作り直せば元に戻れてしまう。
App Store は、アカウントを作れるアプリにアプリ内での削除を求めている。

### 最初の管理者を作る

`is_admin` はクライアントから立てられないので、最初の1人だけ service role で入れる。

```sql
update profiles set is_admin = true where id = '<運営のユーザーID>';
```

以降はアプリから `review_volunteer(user_id, 'approved')` で承認できる。

## 手元で立てる（Docker）

Supabase 本体（Auth / Realtime / Edge Functions）はここに入れていない。
それは `supabase start` の仕事で、二重に持つと設定がずれる。
compose が立てるのは「Supabase CLI が無くても触れる部分」だけ。

```bash
docker compose up -d db livekit   # 軽い。すぐ上がる
docker compose up -d ocr          # 初回はモデルを落とすので数分かかる
```

| サービス | 何が上がるか |
|---|---|
| `db` | マイグレーション6本を当てた PostgreSQL 17（`localhost:55432`）。テストと SQL いじり用 |
| `livekit` | 開発モードの SFU（`ws://localhost:7880`、鍵は `devkey` / `secret`）。通話の疎通確認用 |
| `ocr` | PaddleOCR（`http://localhost:8081`）。読み上げと書類チェックの確認用 |

`db` は初回起動時に `supabase/tests/supabase_stub.sql` と
`supabase/migrations/*.sql` を順に当てる。stub は `auth` スキーマと
3つのロールだけを最小限作るもので、`auth.uid()` は GUC から読む差し替え版になっている。
手元で「誰として実行するか」を切り替えられる:

```sql
set role authenticated;
set app.uid = '<ユーザーID>';
select * from help_requests;   -- その人から見えるものだけ返る
```

テストもこの DB に向けられる:

```bash
PGURL=postgresql://postgres:postgres@127.0.0.1:55432/postgres ./supabase/tests/run.sh
```

## 動かす

### 1. Supabase

本番（Supabase のプロジェクト）へ:

```bash
supabase db push
supabase config push          # ログインコード入りのメール文面もここで反映される
supabase functions deploy livekit-token
supabase functions deploy ring-volunteers
supabase functions deploy inspect-identity
supabase functions deploy purge-identity-documents
supabase functions deploy read-image
supabase functions deploy delete-account
```

手元で全部を立てる場合は下の「手元で通しで動かす」を参照。

Edge Function に必要なシークレット:

```bash
supabase secrets set \
  LIVEKIT_URL=wss://xxxx.livekit.cloud \
  LIVEKIT_API_KEY=... \
  LIVEKIT_API_SECRET=...
```

iOS の VoIP 着信を使う場合は追加で
`APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY`（.p8 の中身）。

定期実行（期限切れ依頼の掃除・承認が外れた人の待機解除・書類画像の削除）は
`0008_schedules.sql` が pg_cron に登録する。画像の削除だけは Edge Function を
呼ぶので、URL と service role キーを一度だけ Vault に入れる
（マイグレーションに書かないのは、公開リポジトリだから）:

```sql
select vault.create_secret('https://<project>.supabase.co', 'project_url');
select vault.create_secret('<service role key>', 'service_role_key');
```

**ログインのメール文面。** アプリも運営画面も「6桁のコードを入力する」作り。
Supabase 既定のテンプレートはリンクしか載せないので、そのままでは
**誰もログインできない**（手元の検証で実際にそうなった）。
`supabase/templates/login_code.html` がコード入りの文面で、`config.toml` から
参照している。スクリーンリーダーは「315315」を「三十一万五千…」と数として
読むので、「3、1、5、3、1、5」と1桁ずつ区切った形も並べてある。

### 2. アプリ

Expo Go では動かない（LiveKit / CallKeep / PushKit がネイティブモジュールのため）。dev client を焼く。

```bash
cd app
cp .env.example .env   # Supabase の URL と anon key を入れる
npm install
npx expo prebuild --clean
npx expo run:ios       # または run:android
```

### 3. 運営画面

```bash
cd admin
cp .env.example .env   # Supabase の URL と anon key を入れる
npm install
npm run dev            # http://localhost:5180
```

コンテナで配る場合（nginx。`no-referrer` / `noindex` / `DENY` のヘッダ付き）:

```bash
ADMIN_SUPABASE_ANON_KEY=<anon key> docker compose --profile admin up -d --build admin
```

キーを渡し忘れるとビルドの時点で止まる。空のまま焼くと、開けるのに
何もできない壊れた画面になるため。

service role キーはフロントに置かない。運営も普通のユーザーとしてログインし、
`is_admin` で通す。画面を隠すのは親切であって守りではなく、実際の防御は
RLS と `is_admin` を見る RPC 側にある。

最初の管理者の作り方は上の「最初の管理者を作る」を参照。

### 4. OCR サーバ（任意）

```bash
docker compose up -d ocr    # http://localhost:8081
```

**モデルは mobile 系（`PP-OCRv5_mobile_det` / `PP-OCRv5_mobile_rec`）を既定にしている。**
`lang="japan"` を渡すと PaddleOCR は server 系（数百MB）を選び、
実際に取得が詰まってビルドが25分走って落ちた。mobile 系は一式 **35MB**。

日本語専用の rec モデルは存在せず、`lang="japan"` も汎用の PP-OCRv5 rec を
使っているだけなので、mobile に落としても日本語は読める（下の結合テストで確認済み）。
落ちるのは精度のほうで、上げたいときは環境変数で server 系に戻せる:

```bash
OCR_DET_MODEL=PP-OCRv5_server_det OCR_REC_MODEL=PP-OCRv5_server_rec docker compose up -d ocr
```

モデルはイメージに焼かず、`/root/.paddlex` を volume に逃がしてある。
**最初の1リクエストだけ待たされ（手元の回線で約9分）、以降は 0.3秒前後**。
再起動しても落とし直さない。

単体テスト（モデル不要の部分）:

```bash
docker compose exec -T ocr python - < ocr/test_inspection.py   # 書類の自動チェック
docker compose exec -T ocr python - < ocr/test_framing.py      # 撮影の案内の材料（向きの戻し方など）
```

実モデルを通す結合テスト（日本語の見本画像。フォントはテストのときだけ持ち込む）:

```bash
docker cp "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc" eyes-bridge-ocr-1:/tmp/jp.ttc
docker compose exec -T ocr python - < ocr/test_japanese_sample.py
docker compose exec -T ocr rm -f /tmp/jp.ttc
```

**OCR サーバは外に公開しない。** 呼べるのは Edge Function だけ
（読み上げは `read-image`、本人確認は `inspect-identity`）。アプリは OCR サーバを直接呼ばない。
利用者のログインと回数の上限は Edge Function 側で確かめ、OCR サーバは共有の鍵
（`OCR_TOKEN`）だけを見る。どのサイトからの呼び出しも許可していない（CORS）。
以前は `/ocr` に鍵が無く、URL が分かれば誰でも無料の読み取りとして使えた。

OCR サーバと Edge Function に同じ鍵を渡す:

```bash
supabase secrets set OCR_URL=http://<ホスト>:8081 OCR_TOKEN=<共有する秘密>
```

`OCR_TOKEN` が未設定だと、OCR サーバはすべての口を 503 で閉じる。
設定し忘れを「誰でも通る」で吸収しないため。

## 手元で通しで動かす

本物の Supabase（Auth / Storage / Realtime / Edge Functions / pg_cron）を立てて、
全部つなげる。初回はイメージの取得に時間がかかる（合計 5GB ほど）。

```bash
supabase start -x imgproxy,logflare,vector,supavisor,studio,postgres-meta
supabase functions serve --env-file supabase/functions/.env   # 下の .env を用意
docker compose up -d livekit ocr
```

`supabase/functions/.env`（手元用。.gitignore 済み）:

```
LIVEKIT_URL=ws://host.docker.internal:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
OCR_URL=http://host.docker.internal:8081
OCR_TOKEN=local-dev-ocr-token
```

運営画面を触ってみるデモデータ（運営は `ops-demo@example.test`。
ログインコードは Mailpit http://127.0.0.1:54324 に届く）:

```bash
eval "$(supabase status -o env | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
export E2E_CARD_JPG=/path/card.jpg E2E_SELFIE_JPG=/path/selfie.jpg   # 見本画像（実在の書類は使わない）
deno run --allow-net --allow-env --allow-read scripts/seed_admin_demo.ts          # 入れる
deno run --allow-net --allow-env --allow-read scripts/seed_admin_demo.ts --clean  # 消す
```

見本画像は `ocr/test_japanese_sample.py` と同じ作り方（フォントで描いた「見本 花子」）。

## テスト

4種類ある。上から速い順。

```bash
./supabase/tests/run.sh                                        # SQL 122件（stub。Supabase 不要）
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  ./supabase/tests/run.sh                                      # SQL 122件（本物の Supabase）
(cd supabase/functions && deno test --allow-env --allow-read _tests/)   # Edge Function 6件
(cd app && npm test)                                           # 読み上げ・撮影の案内・薬の注意・規約 36件
deno run --allow-net --allow-env --allow-read scripts/e2e_local.ts      # 通し 54件
```

SQL テストは同じファイルを stub と本物の両方に流せる。stub は速いが、
テーブルの所有者や「postgres が superuser でない」ことなど本物との差は
再現しきれない（実際に 0006 がそれで本物でだけ落ちた）。本物に流すときは
各ファイルを `begin ... rollback` で包むので、DB に何も残さない。

本物の Supabase に流す SQL テストと通しのテストは、**空の DB が前提**。
件数で「見える範囲」を確かめているのと、使い回し検出が DB 全体を見るため。
デモデータが入っていると、的外れに何十件も落ちる代わりに先にはっきり止まる
（`seed_admin_demo.ts --clean` で消してから流す）。

ランナーは「FAIL が無い」だけでは通さない。psql の異常終了と、
PASS が1件も無いことも失敗として扱う（接続に失敗して何も走らなかったのに
「通った」と報告していたことがあるため）。

SQL テストで確かめていること（122件）:

* 未審査のボランティアに待機列が見えない / 依頼を取れない
* 自分で自分を承認できない / 自分を管理者にできない（列権限）
* 管理者でない人は他人を承認できない
* 取り合いで勝つのは1人だけ（2人目は `ALREADY_TAKEN`）
* ブロックした相手には依頼が見えない / 取れない
* 無関係の人は通報できない / 通報テーブルへの直接 insert が塞がれている
* 別々の3人から通報されると自動停止する（2人では止まらない）
* 通報された本人に通報が見えない
* 本人確認前のボランティアは承認できない（停止はできる）
* マイナンバーカードの裏面は受け付けない
* 他人のフォルダのパスで本人確認を提出できない
* 審査待ちを二重に積めない
* 本人確認書類は本人と運営にしか見えない / 置けない
* 画像を消しても審査の結果は残る
* 一般ユーザーには自分の行しか見えず、運営だけが全体を見られる
* 自動チェックは service role しか書けない（運営でも本人でも直接書けない）
* 別アカウントが同じ人の書類を出すと `duplicate_document` が立ち、別人の書類・識別子の無い書類では立たない
* 通報を処理済みにできるのは運営だけ
* 依頼の表を直接書き換えられない（作成時刻をずらして上限をすり抜ける、状態を変える、を含む）
* 未処理の依頼は1人1件。ただし時間切れで残った依頼では閉じ込めない
* 依頼は10分に6件・1日40件まで。サーバ側からの登録には掛けない
* 着信は1依頼につき1回だけ送れる
* 依頼者も、別々の3人から通報されると利用が止まり、待っている依頼は取り下げられる
* 利用停止を外せるのは運営だけ（自分では外せない）
* 読み取りは10分に30回まで。止まっている人・未ログインは使えない
* 要配慮個人情報への同意が無いと依頼者として登録できず、そのとき役割は保存されない
* 役割・同意の記録は直接書き換えられない。古い版への同意では登録できない
* 文書の版が上がったら、同意し直すまで依頼を立てられず、ボランティアは待機列に入れない
* 退会すると控えは識別子と停止の有無だけになり、誰だったかは残らない。利用者からは読めない
* 退会した人の書類で作り直すと旗が立ち、止められていた人なら強い旗になる

アプリのテスト（36件。端末不要、`node --test`）:

* スクリーンリーダー使用中はその声だけ、未使用ならアプリの声だけで読む（二重にならない）
* 撮影の案内：本物の OCR の出力9場面で、何と言うかを確かめる
  （右がはみ出た・横向きに撮って上がはみ出た・寄りすぎ・ぼけ・白紙・暗いが読めた、など）
* 薬の注意：薬袋や説明書によくある書き方では必ず付き、「薬味」「食後にコーヒー」
  「内容量 500ml」のような薬でない文では付かない
* 規約：docs/legal/ が本文と同じか、アプリと DB で版が揃っているか、外してはいけない内容があるか

Edge Function のテスト（6件）:

* トークンの JWT に載る権限が、依頼者は `camera`+`microphone`、ボランティアは `microphone` だけ
* APNs のプロバイダトークンの署名を、その場で作った P-256 の鍵の公開鍵で検証できる

通しのテスト `scripts/e2e_local.ts`（54件）:

* 発行したトークンを LiveKit サーバ自身が受け付ける（`/rtc/validate`）
* 書類 → Storage → `inspect-identity` → OCR コンテナ → 判定の保存、が一本でつながる
* 別アカウントが同じ書類を出すと `duplicate_document` が立ち、**様式が同じ別人の免許証では立たない**
* 審査前は依頼を取れず、本人確認と承認を経ると取れる
* 期限切れの書類画像が Storage から実際に消え、審査の結果は残る
* 2件目の依頼・作成時刻の改ざん・依頼の直接の書き換えが、どれも通らない
* 同じ依頼で2回目の着信は `ALREADY_RUNG` で断られる
* OCR サーバは鍵なしでは使えず、ログインしていれば `read-image` を通して読める
* 退会するとアカウント・役割・同意・書類の画像が実際に消え、同じ書類で作り直すと旗が立つ

## まだ塞いでいない穴

- **実機で一度も動かしていない。** 通話も着信も、音と映像が実際に通るかは
  ネイティブビルドを通すまで分からない。検証に使った Mac には Xcode も
  Android SDK も無く、ここだけは手が出せていない。
  トークンの発行と LiveKit サーバがそれを受け付けることまでは確認済み。
- **react-native-callkeep は New Architecture で未検証。**
  Expo SDK 57 は New Architecture が既定で、`expo-doctor` が
  「Untested on New Architecture」と報告する。着信まわりが本番で
  一番壊れると痛い箇所なので、実機で最初に確かめるのはここ。
- **本物の書類で試していない。** 見本画像（平らな背景にフォントで描いたもの）は
  読めたが、実物の撮影写真は反射・傾き・地紋があり条件がまったく違う。
  モアレの閾値（40）も OCR 信頼度の下限（0.6）も、実データで詰めていない仮の値。
- **撮影の案内は「撮った後」だけ。撮る前（ライブ）の案内はしていない。**
  今のカメラ部品（expo-camera）には映像をコマ単位で受け取る仕組みが無い。
  撮る前に「もう少し右」と言うには VisionCamera と端末内の文字検出が要るが、
  ネイティブのビルドと実機での確認ができる環境が無いので手を付けていない。
  判断のロジック（`framing.ts`）はそのまま使える形にしてある。
- **券面の顔写真と自撮りの照合はしていない。** 上の「やっていないこと」を参照。
- **着信の実送信は確かめていない。** `ring-volunteers` が動き、依頼者以外を
  弾くことまでは確認したが、Expo / APNs に実際に送ってはいない
  （外部サービスに送ることになるため）。
- **TURN の実地確認をしていない。** LiveKit Cloud 前提なら不要だが、自前 SFU に移すときに詰まる。
- **端末内 TTS は sherpa-onnx ではなく OS 標準（expo-speech）。**
  sherpa-onnx には React Native バインディングが存在しないため。
  日本語は iOS / Android とも標準 TTS がオフラインで実用水準にある。
  声質にこだわる場合はサーバ側で VOICEVOX か Piper を挟む。

## 検証したこと / していないこと

済んでいるもの:

* SQL テスト 122件を **stub と本物の Supabase の両方で**（マイグレーション12本）
* Edge Function 4本の Deno の型チェックと、単体テスト 6件
* 通しのテスト 54件（本物の Supabase + Edge Functions + LiveKit + OCR）
* 運営画面を**ブラウザで実際に操作**：コードでのログイン、書類画像の表示
  （署名付き URL）、旗の表示、理由なしの却下を止める、本人確認の承認、
  本人確認が済むまでボランティアの承認ボタンが押せない、通報の対応。
  操作の結果が DB に残り、審査者・対応者が記録されることも確認
* `docker compose` の db / livekit / ocr / admin が healthy で上がる
* OCR：単体 15件、日本語の見本画像での結合 9件（mobile 系モデル）
* RN アプリの `tsc --noEmit`、`expo-doctor` 21項目中20項目
* **アプリの JavaScript を iOS / Android 向けに実際に束ねられる**（`npx expo export`。
  985 モジュール → Hermes のバイトコード 4.4MB）。ネイティブのビルドとは別で、
  スマホが無くてもできる。すべての import が解決し、実行時と同じ変換が通ることを確かめる

検証の途中で見つかって直した不具合（詳細はコミット履歴）:

* **トークン発行が毎回失敗していた。** LiveKit SDK に文字列を渡しており、
  変換で例外になっていた。誰も通話に入れない状態だった
* **ログインのメールにコードが入っていなかった。** 誰もログインできない状態だった
* **0006 が本物の Supabase で落ちた。** 本番への db push も同じ場所で落ちていた
* **テストランナーが、何も走っていないのに「通った」と報告していた**

していないもの:

* **実機での通話と着信。**
* **OCR の精度を実物の書類で。**

## ライセンスの注意

依存している OSS はすべて Apache-2.0 / MIT / ISC。
ただし OCR を日本語特化に差し替える場合、YomiToku は CC BY-NC-SA 系なので商用利用の可否を確認すること。

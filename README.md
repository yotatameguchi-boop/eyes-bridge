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

**状態変化は必ず三重に伝える。**
`notifyStateChange()` が「スクリーンリーダーへの読み上げ + 実際の発話 + 振動」を同時に出す。
スクリーンリーダー未使用の弱視者には `announceForAccessibility` が届かず、
騒がしい場所では音が落ち、ポケットの中では振動しか残らない。どれか1つでは必ず取りこぼす。

**OCR の信頼度をそのままアプリまで返す。**
黙って間違った金額や用量を読み上げるのが一番危ない。
信頼度 0.6 未満の行が混じったら「はっきり読めない部分があります」と先に言う。

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
| `duplicate_document` | soft | 同じ書類が別のアカウントでも使われている |
| `no_face_in_document` | soft | 顔写真のある面を撮っていない疑い |
| `possible_screen_capture` | weak | モアレが強い。布や網戸ごしでも上がる |
| `expiry_not_found` | weak | 期限を読めなかった。記載位置は書類ごとに違う |

**使い回しの検出は知覚ハッシュ（pHash）で行う。**
完全一致だけを見ると、撮り直し・トリミング・圧縮で別物になってすり抜ける。
DCT ベースの 64bit ハッシュを取り、ハミング距離6以内を「同じ書類」とみなす。
ハッシュからは元画像を復元できないので、**画像を消したあとも残せる**。
本物の免許証を他人から借りている場合もここに出る。

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

**別々の3人から通報されると自動で停止する。**
1人が連打しても止まらないよう、`count(distinct reporter_id)` で数える。

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
| `ocr` | PaddleOCR（`http://localhost:8080`）。読み上げ経路の確認用 |

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

```bash
supabase start
supabase db push
supabase functions deploy livekit-token
supabase functions deploy ring-volunteers
```

Edge Function に必要なシークレット:

```bash
supabase secrets set \
  LIVEKIT_URL=wss://xxxx.livekit.cloud \
  LIVEKIT_API_KEY=... \
  LIVEKIT_API_SECRET=...
```

iOS の VoIP 着信を使う場合は追加で
`APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY`（.p8 の中身）。

時間切れの掃除は pg_cron から:

```sql
select cron.schedule('expire-requests', '* * * * *', $$select expire_stale_requests()$$);
```

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

service role キーはフロントに置かない。運営も普通のユーザーとしてログインし、
`is_admin` で通す。画面を隠すのは親切であって守りではなく、実際の防御は
RLS と `is_admin` を見る RPC 側にある。

最初の管理者の作り方は上の「最初の管理者を作る」を参照。

### 4. OCR サーバ（任意）

```bash
cd ocr
docker build -t eyes-bridge-ocr .
docker run -p 8080:8080 eyes-bridge-ocr
```

`app/.env` に `EXPO_PUBLIC_OCR_URL=http://<ホスト>:8080` を足すと「機械に読ませる」が有効になる。
未設定でも通話側は動く。

本人確認の自動チェックを使う場合は、OCR サーバに `INSPECT_TOKEN` を設定し、
同じ値を Edge Function 側にも渡す:

```bash
supabase secrets set OCR_URL=http://<ホスト>:8080 INSPECT_TOKEN=<共有する秘密>
```

`INSPECT_TOKEN` が未設定だと `/inspect-document` は 503 で閉じる。
本人確認書類が飛んでくる口を、設定し忘れで誰でも叩ける状態にしないため。

## テスト

マイグレーションを実際の PostgreSQL に当てて、安全側の挙動を確かめる。
Supabase を立てなくても回る（`auth` スキーマと3つのロールだけ stub で作る）。

```bash
./supabase/tests/run.sh
```

一時クラスタを勝手に立てて捨てる。既存の DB を使う場合は `PGURL=postgres://... ./supabase/tests/run.sh`。

確かめていること（51件）:

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
* 別アカウントのほぼ同じ書類に `duplicate_document` が立ち、別物では立たない
* 通報を処理済みにできるのは運営だけ

## まだ塞いでいない穴

- **実機で一度も動かしていない。** ネイティブビルドが要るので、通話も着信も未検証。
  音と映像が実際に通るか、VoIP push が鳴るかはここを通すまで分からない。
- **react-native-callkeep は New Architecture で未検証。**
  Expo SDK 57 は New Architecture が既定で、`expo-doctor` が
  「Untested on New Architecture」と報告する。着信まわりが本番で
  一番壊れると痛い箇所なので、実機で最初に確かめるのはここ。
- **運営画面をブラウザで表示していない。** 型チェックとビルドは通っているが、
  実際に描画して操作したわけではない。
- **自動チェックを本物の書類で試していない。** モアレの閾値（40）も
  OCR の信頼度の下限（0.6）も、実データで詰めていない仮の値。
- **券面の顔写真と自撮りの照合はしていない。** 上の「やっていないこと」を参照。
- **OCR サーバのコンテナを起動できていない。** イメージのビルドが長く、未完了。
- **TURN の実地確認をしていない。** LiveKit Cloud 前提なら不要だが、自前 SFU に移すときに詰まる。
- **端末内 TTS は sherpa-onnx ではなく OS 標準（expo-speech）。**
  sherpa-onnx には React Native バインディングが存在しないため。
  日本語は iOS / Android とも標準 TTS がオフラインで実用水準にある。
  声質にこだわる場合はサーバ側で VOICEVOX か Piper を挟む。

## 検証したこと / していないこと

済んでいるもの:

* `supabase/tests/run.sh` 51件（実 PostgreSQL 17 にマイグレーション7本を適用して実行）
  テストファイルごとに DB を作り直すので、実行順で結果が変わらない
* `docker compose up -d db livekit` が上がり、コンテナの DB に対してもテストが通る
* 運営画面の `npm run build`（TypeScript の型チェック込み）
* `tsc --noEmit`（TypeScript 6）が通る
* `expo-doctor` 21項目中20項目
* OCR サーバの Python 構文

していないもの:

* **実機での通話と着信。**
* **Edge Function の実行。** Deno 未導入のため esbuild による構文確認のみ。
  `npm:` 指定の解決は `supabase functions serve` で確かめること。
* **OCR の精度。** PaddleOCR の日本語モデルを実際の薬袋やレシートに
  当てていない。読み順の並べ替えロジックは実データで詰める必要がある。

## ライセンスの注意

依存している OSS はすべて Apache-2.0 / MIT / ISC。
ただし OCR を日本語特化に差し替える場合、YomiToku は CC BY-NC-SA 系なので商用利用の可否を確認すること。

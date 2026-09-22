# eyes-bridge

目が見えない・見えにくい人が、目の前の文字を見える人に読んでもらうためのアプリ。
押すと、待機中のボランティア1人と1対1の通話で繋がる。人が捕まらない時間帯は、その場で機械が読み上げる。

## 構成

```
RN（callkeep で OS の着信画面）
  ├ 通話: LiveKit（Cloud → 必要になったら自前 SFU）
  ├ 待機列: Supabase Realtime Presence + Postgres
  └ AI経路: 端末内 TTS（expo-speech）+ サーバ側 PaddleOCR
```

| ディレクトリ | 中身 |
|---|---|
| `app/` | React Native (Expo SDK 57 / dev client)。依頼者とボランティアの両方 |
| `supabase/migrations/` | スキーマ・RLS・取り合いを解決する RPC |
| `supabase/functions/` | LiveKit トークン発行、待機者への一斉着信（APNs VoIP 対応） |
| `ocr/` | FastAPI + PaddleOCR。写真から日本語を読み順つきで返す |

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
DB に持つのは「誰が・いつ・何秒繋がったか」だけ。依頼の本文も、映像も、OCR 結果も残さない。
薬袋・請求書・診断書が飛んでくる前提なので、保存した瞬間にそこが漏洩面になる。

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

VoIP push まで行く場合は追加で `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY`（.p8 の中身）。

時間切れの掃除は pg_cron から:

```sql
select cron.schedule('expire-requests', '* * * * *', $$select expire_stale_requests()$$);
```

### 2. アプリ

Expo Go では動かない（LiveKit と CallKeep がネイティブモジュールのため）。dev client を焼く。

```bash
cd app
cp .env.example .env   # Supabase の URL と anon key を入れる
npm install
npx expo prebuild --clean
npx expo run:ios       # または run:android
```

### 3. OCR サーバ（任意）

```bash
cd ocr
docker build -t eyes-bridge-ocr .
docker run -p 8080:8080 eyes-bridge-ocr
```

`app/.env` に `EXPO_PUBLIC_OCR_URL=http://<ホスト>:8080` を足すと「機械に読ませる」が有効になる。
未設定でも通話側は動く。

## まだ塞いでいない穴

- **iOS で「電話として鳴る」のは未完成。** Expo push（通常通知）までは動く。
  アプリ終了状態から CallKit の着信画面を出すには PushKit の VoIP push が要る。
  **サーバ側の送信処理は `supabase/functions/_shared/apns.ts` に実装済み**で、
  `volunteer_status.push_kind` を `apns_voip` にすればそちらに流れる。
  残っているのは端末側の `react-native-voip-push-notification` 導入で、
  Expo config plugin が無いため `prebuild` 後のネイティブ編集になる。
  Android は ConnectionService（selfManaged）で現状のまま鳴る。
- **ボランティアの身元確認が無い。** 誰でも登録できて、誰でも他人のカメラ映像を見られる。
  公開する前に、本人確認・通報導線・ブロックが必ず要る。
- **通報とブロックが無い。** `help_requests` に当事者は残っているので、
  通報テーブルを足して紐づければ実装できる形にはなっている。
- **TURN の実地確認をしていない。** LiveKit Cloud 前提なら不要だが、自前 SFU に移すときに詰まる。
- **端末内 TTS は sherpa-onnx ではなく OS 標準（expo-speech）。**
  sherpa-onnx には React Native バインディングが存在しないため。
  日本語は iOS / Android とも標準 TTS がオフラインで実用水準にある。
  声質にこだわる場合はサーバ側で VOICEVOX か Piper を挟む。

## ライセンスの注意

依存している OSS はすべて Apache-2.0 / MIT / ISC。
ただし OCR を日本語特化に差し替える場合、YomiToku は CC BY-NC-SA 系なので商用利用の可否を確認すること。

# 業務自動化Backend

## 機能1. 日報

Slackのメッセージを選択してBacklogの日報プロジェクト（プロジェクトキー `NIPPO`）の今週の課題にコメントとして送信する。

投稿はメッセージショートカット `送信先：日報Backlog`（`callback_id = send_nippo_to_backlog`）から行う。Backlog上のコメント作成者を「実行したSlackユーザー本人」にするため、各メンバーが自分のBacklog APIキーをSlack経由で登録する。

### 1.1 環境変数

| 変数名                     | 用途                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `BACKLOG_SPACE_ID`         | Backlogスペース（`<space>.backlog.com` の `<space>`）                 |
| `SLACK_BOT_TOKEN`          | Slackアプリのbotトークン（`views.open` / `views.update` 用）          |
| `SLACK_SIGNING_SECRET`     | Slack Request署名検証用シークレット（未設定時は警告ログのみで素通し） |
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST URL（Vercel連携で自動設定）                        |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis RESTトークン（同上）                                    |

`@upstash/redis` の `Redis.fromEnv()` を使うため `UPSTASH_REDIS_REST_*` を参照する。Vercel上ではMarketplaceからUpstash for Redisを連携すると自動で注入される。

### 1.2 Slackアプリ

- **Interactivity & Shortcuts** を有効化し、Request URLに `https://<your-domain>/api/nippo/slack-to-backlog` を設定。
  - Message Shortcut を作成： `Callback ID = send_nippo_to_backlog`
- **Slash Commands** で `/nippo-setup` を作成し、Request URLに同じく `https://<your-domain>/api/nippo/slack-to-backlog` を設定（手動でAPIキーを再登録するため）。
- **OAuth & Permissions** で以下のbotスコープを付与：
  - `commands`
  - `chat:write`（必要に応じて）
- アプリをワークスペースにインストールし、`SLACK_BOT_TOKEN` を取得して環境変数に設定。

### 1.3 メンバーごとのAPIキー登録フロー

1. 利用者が日報メッセージで `送信先：日報Backlog` ショートカットを実行。
2. APIキー登録済の場合は「送信中…」モーダルが表示され、Backlogへ投稿後に「送信完了」モーダル（課題タイトル＋Backlogリンク）に切り替わる。
3. APIキー未登録の場合は自動で登録モーダルが開く。Backlogの個人設定 → API で発行したキーを貼って保存すると、そのまま元メッセージが今週の課題にコメントとして投稿され、結果モーダルに切り替わる。
4. キーを差し替えたい場合は `/nippo-setup` で登録モーダルを再度開いて上書き。

APIキーは `backlog:apikey:<slack_user_id>` キーでUpstash Redisに保存される。

### 1.4 サーバー側ガード

ショートカット実行時、以下の条件はサーバー側で弾いて警告モーダルを返す（Backlogへは投稿しない）。

| 条件                          | 警告モーダル                                          | 判定方法                                                                                          |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| メッセージ本文が空            | 「メッセージが空です」                                | `message.text.trim()` が空                                                                        |
| 同じメッセージを重複投稿      | 「投稿済み」                                          | `nippo:posted:<channel_id>:<message_ts>` が Upstash Redis に存在（投稿成功時に 30 日 TTL で記録） |
| 同一ユーザーが 5 分以内に連投 | 「連続実行のため待機中（あと約 X 分 Y 秒）」 | `nippo:rate:<slack_user_id>` が存在（投稿成功時に 5 分 TTL で記録）                              |

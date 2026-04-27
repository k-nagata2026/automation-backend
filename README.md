# 業務自動化Backend

## 機能1. 日報

Slackのメッセージを選択してBacklogの日報プロジェクト（プロジェクトキー `NIPPO`）の今週の課題にコメントとして送信する。

投稿はメッセージショートカット `送信先：日報Backlog`（`callback_id = send_nippo_to_backlog`）から行う。Backlog上のコメント作成者を「実行したSlackユーザー本人」にするため、各メンバーが自分のBacklog APIキーをSlack経由で登録する。

### 1.1 環境変数

| 変数名                     | 用途                                                  |
| -------------------------- | ----------------------------------------------------- |
| `BACKLOG_SPACE_ID`         | Backlogスペース（`<space>.backlog.com` の `<space>`） |
| `SLACK_BOT_TOKEN`          | Slackアプリのbotトークン（`views.open` 用）           |
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST URL（Vercel連携で自動設定）        |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis RESTトークン（同上）                    |

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
2. APIキー未登録なら自動で登録モーダルが開く。Backlogの個人設定 → API で発行したキーを貼って保存。
3. 保存と同時に、当初のメッセージがそのまま今週の課題にコメントとして投稿される。
4. 後からキーを差し替えたい場合は `/nippo-setup
APIキーは `backlog:apikey:<slack_user_id>` キーでUpstash Redisに保存される。

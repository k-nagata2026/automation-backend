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
3. 同日に同じ課題へ既にコメント済みだった場合は「投稿済み」モーダルに切り替わり、「上書きする」/「キャンセル」を選べる。「上書きする」を選ぶと、選択中のメッセージ内容で既存コメントが更新される。
4. APIキー未登録の場合は自動で登録モーダルが開く。Backlogの個人設定 → API で発行したキーを貼って保存すると、そのまま元メッセージが今週の課題にコメントとして投稿され、結果モーダルに切り替わる。
5. キーを差し替えたい場合は `/nippo-setup` で登録モーダルを再度開いて上書き。

APIキーは `backlog:apikey:<slack_user_id>` キーでUpstash Redisに保存される。

### 1.4 サーバー側ガード

ショートカット実行時、以下の条件はサーバー側で弾いて警告モーダルを返す（Backlogへは投稿しない）。

| 条件                          | 警告モーダル                                 | 判定方法                                                                                                                                          |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| メッセージ本文が空            | 「メッセージが空です」                       | `message.text.trim()` が空                                                                                                                        |
| 同一ユーザーが 5 分以内に連投 | 「連続実行のため待機中（あと約 X 分 Y 秒）」 | `nippo:rate:<slack_user_id>` が Upstash Redis に存在（投稿成功時に 5 分 TTL で記録）                                                              |
| 同日に既にコメント済み        | 「投稿済み」（上書き確認モーダル）           | Backlog `/api/v2/users/myself` で取得した自分の Backlog ID が、`/api/v2/issues/{key}/comments` の `createdUser.id` に含まれ、かつ `created` が JST で本日のものを検出（最大 5 ページ＝500 コメントまで遡る）。検出時は「上書きするか」を確認するモーダルを表示し、ユーザーが「上書きする」を選んだ場合のみ既存コメントを `PATCH /api/v2/issues/{key}/comments/{commentId}` で更新する。 |

## 機能2. PRレビュー（Claude）

GitHub App として動作し、PR が作成・更新されるたびに Claude が差分をレビューして PR にコメント投稿し、Slack にサマリを通知する。リポジトリ側にワークフローファイルを置く必要はなく、対象リポジトリに App をインストールするだけで有効になる。

### 2.1 エンドポイント

`POST https://<your-domain>/api/pr-review`

GitHub App の Webhook 受信専用。`X-Hub-Signature-256` を `GITHUB_WEBHOOK_SECRET` で検証し、`pull_request` イベントの `opened` / `synchronize` / `reopened` のみ処理する（draft PR は除外）。重い処理は `next/server` の `after()` でバックグラウンド実行し、GitHub には即座に 200 を返す。

### 2.2 環境変数

| 変数名                     | 用途                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`            | GitHub App の App ID                                                                  |
| `GITHUB_APP_PRIVATE_KEY`   | App の秘密鍵。PEM 直貼り、もしくは base64 エンコードのどちらでも可                    |
| `GITHUB_WEBHOOK_SECRET`    | Webhook 署名検証用シークレット                                                        |
| `ANTHROPIC_API_KEY`        | Anthropic API キー（モデル: `claude-opus-4-7`）                                       |
| `SLACK_BOT_TOKEN`          | 機能1と共用。Bot スコープ `chat:write` 必須                                           |

通知先 Slack チャンネルは `route.ts` 内に固定（`C0B2JAS7NLR` / zero-accel ワークスペース）。変更時はソース修正＋再デプロイ。

### 2.3 GitHub App の設定

https://github.com/settings/apps/new で作成：

- **Webhook URL**: `https://<your-domain>/api/pr-review`
- **Webhook secret**: `GITHUB_WEBHOOK_SECRET` と同じ値
- **Repository permissions**:
  - Pull requests: **Read & write**
  - Contents: **Read**
  - Metadata: **Read**
- **Subscribe to events**: **Pull request**

作成後に App ID をメモし、Generate a private key で `.pem` をダウンロード。`base64 -i <pem>` で base64 化したものを Vercel の `GITHUB_APP_PRIVATE_KEY` に登録する。最後に App ページの **Install App** から対象リポジトリにインストール。

### 2.4 処理フロー

1. GitHub から `pull_request` Webhook を受信し、署名を検証。
2. App JWT（RS256）を生成し、ペイロードの `installation.id` から installation access token を発行。
3. `GET /repos/{repo}/pulls/{n}` を `Accept: application/vnd.github.v3.diff` で叩いて差分を取得（180KB 超は末尾を打ち切る）。
4. Claude (`claude-opus-4-7`) に差分を渡し、`{ review, summary }` の JSON で出力させる。レビュー観点は バグ / セキュリティ / パフォーマンス / 可読性 / Liquid 構文（Shopify・ecforce テーマ向け）で、各指摘に重大度ラベル（blocker / major / minor / nit）を付与する。
5. `review` を PR にコメント投稿（`POST /repos/{repo}/issues/{n}/comments`）。
6. `summary` を Slack の `chat.postMessage` で `SLACK_CHANNEL_ID` に送信（PR タイトル・URL・作成者を併記）。

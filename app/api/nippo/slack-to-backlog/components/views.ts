import {
  APIKEY_ACTION_ID,
  APIKEY_BLOCK_ID,
  BACKLOG_PROJECT_KEY,
  RATE_LIMIT_WINDOW_SEC,
  VIEW_CALLBACK_ID,
} from "./constants";
import type { PostResult } from "./backlog";
import type { GuardFailure } from "./kv";
import type { ModalView } from "./slack";
import { formatJstDate } from "./shared";

export function buildApiKeyModal(privateMetadata: string): ModalView {
  return {
    type: "modal",
    callback_id: VIEW_CALLBACK_ID,
    title: { type: "plain_text", text: "Backlog APIキー登録" },
    submit: { type: "plain_text", text: "保存" },
    close: { type: "plain_text", text: "キャンセル" },
    private_metadata: privateMetadata,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Backlogの個人設定 → API でキーを発行し、ここに貼り付けてください。\n保存後はあなたのBacklogユーザーとして日報コメントが投稿されます。",
        },
      },
      {
        type: "input",
        block_id: APIKEY_BLOCK_ID,
        label: { type: "plain_text", text: "Backlog APIキー" },
        element: {
          type: "plain_text_input",
          action_id: APIKEY_ACTION_ID,
          placeholder: { type: "plain_text", text: "貼り付けてください" },
        },
      },
    ],
  };
}

export function buildProcessingView(): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_processing",
    title: { type: "plain_text", text: "送信中" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: Backlogに日報を投稿しています…",
        },
      },
    ],
  };
}

function buildSuccessView(params: {
  issueKey: string;
  summary: string;
  url: string;
}): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_success",
    title: { type: "plain_text", text: "送信完了" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: 日報コメントを投稿しました\n*課題:* <${params.url}|${params.summary}>`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `課題キー: \`${params.issueKey}\``,
          },
        ],
      },
    ],
  };
}

function buildNoIssueView(today: Date): ModalView {
  const label = formatJstDate(today);
  return {
    type: "modal",
    callback_id: "nippo_no_issue",
    title: { type: "plain_text", text: "課題が見つかりません" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: 今日（${label}）を含む日報課題がBacklogプロジェクト \`${BACKLOG_PROJECT_KEY}\` に見つかりませんでした。`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "タイトル形式は `YYYY年M月度(M/D~M/D)` を想定しています（半角/全角の括弧、`~`/`〜`/`～` どれでも可）。該当週の課題が作成されているかご確認ください。",
          },
        ],
      },
    ],
  };
}

export function buildErrorView(message: string): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_error",
    title: { type: "plain_text", text: "送信失敗" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:x: ${message}\n詳細はサーバーログをご確認ください。`,
        },
      },
    ],
  };
}

export function buildRegisteredView(): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_registered",
    title: { type: "plain_text", text: "登録完了" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":white_check_mark: Backlog APIキーを登録しました。",
        },
      },
    ],
  };
}

function buildEmptyMessageView(): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_warning_empty",
    title: { type: "plain_text", text: "メッセージが空です" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":warning: 選択したメッセージに本文がありません。本文があるメッセージで実行してください。",
        },
      },
    ],
  };
}

function buildAlreadyCommentedView(params: {
  summary: string;
  url: string;
}): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_already_commented",
    title: { type: "plain_text", text: "投稿済み" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: 今日の日報コメントは既に投稿済みです。\n*課題:* <${params.url}|${params.summary}>`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "同じ日に再投稿したい場合はBacklog側で既存コメントを削除してから実行してください。",
          },
        ],
      },
    ],
  };
}

function buildRateLimitedView(remainingSec: number): ModalView {
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  const wait =
    remainingSec > 0
      ? `あと約 ${minutes}分${seconds.toString().padStart(2, "0")}秒 後に再度実行できます。`
      : "少し時間を置いてから再度実行してください。";

  return {
    type: "modal",
    callback_id: "nippo_warning_rate",
    title: { type: "plain_text", text: "連続実行のため待機中" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: 前回の投稿から ${RATE_LIMIT_WINDOW_SEC / 60} 分以内です。${wait}`,
        },
      },
    ],
  };
}

export function viewForGuardFailure(guard: GuardFailure): ModalView {
  switch (guard.reason) {
    case "empty":
      return buildEmptyMessageView();
    case "rate_limited":
      return buildRateLimitedView(guard.remainingSec);
  }
}

export function viewForResult(result: PostResult): ModalView {
  if (result.ok) {
    return buildSuccessView({
      issueKey: result.issueKey,
      summary: result.summary,
      url: result.url,
    });
  }
  if (result.reason === "no_issue") {
    return buildNoIssueView(result.today);
  }
  return buildAlreadyCommentedView({
    summary: result.summary,
    url: result.url,
  });
}

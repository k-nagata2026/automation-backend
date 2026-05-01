import { Redis } from "@upstash/redis";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

const SHORTCUT_CALLBACK_ID = "send_nippo_to_backlog";
const VIEW_CALLBACK_ID = "backlog_apikey_register";
const SETUP_COMMAND = "/nippo-setup";
const BACKLOG_PROJECT_KEY = "NIPPO";
const APIKEY_BLOCK_ID = "apikey_block";
const APIKEY_ACTION_ID = "apikey_input";
const SIGNATURE_VERSION = "v0";
const SIGNATURE_TOLERANCE_SEC = 60 * 5;
const RATE_LIMIT_WINDOW_SEC = 60 * 5;
const POSTED_TTL_SEC = 60 * 60 * 24 * 30;

const redis = Redis.fromEnv();

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.text();

    if (!verifySlackSignature(req, rawBody)) {
      return new Response("invalid signature", { status: 401 });
    }

    const params = new URLSearchParams(rawBody);

    const command = params.get("command");
    if (command) {
      return await handleSlashCommand(params);
    }

    const payloadRaw = params.get("payload");
    if (!payloadRaw) {
      return ok();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch (error) {
      console.error("[nippo/slack-to-backlog] failed to parse payload:", error);
      return ok();
    }
    if (!isObject(parsed)) return ok();

    const payload = parsed as SlackPayload;

    if (payload.type === "message_action") {
      return await handleMessageAction(payload as SlackMessageActionPayload);
    }

    if (payload.type === "view_submission") {
      return await handleViewSubmission(payload as SlackViewSubmissionPayload);
    }

    return ok();
  } catch (error) {
    console.error("[nippo/slack-to-backlog] failed to handle request:", error);
    return ok();
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSlashCommand(params: URLSearchParams): Promise<Response> {
  const command = params.get("command");
  if (command !== SETUP_COMMAND) {
    return ok();
  }

  const triggerId = params.get("trigger_id");
  if (!triggerId) {
    return ok();
  }

  try {
    await openModal({
      triggerId,
      view: buildApiKeyModal(""),
    });
  } catch (error) {
    console.error(
      "[nippo/slack-to-backlog] failed to open setup modal:",
      error,
    );
    return Response.json(
      {
        response_type: "ephemeral",
        text: "登録モーダルを開けませんでした。管理者にお問い合わせください。",
      },
      { status: 200 },
    );
  }

  return ok();
}

async function handleMessageAction(
  payload: SlackMessageActionPayload,
): Promise<Response> {
  if (payload.callback_id !== SHORTCUT_CALLBACK_ID) {
    return ok();
  }

  const userId = payload.user?.id;
  const triggerId = payload.trigger_id;
  if (!userId || !triggerId) {
    console.warn(
      "[nippo/slack-to-backlog] missing user id or trigger id in message_action",
    );
    return ok();
  }

  const messageText = payload.message?.text ?? "";
  const messageTs = payload.message?.ts ?? "";
  const channelId = payload.channel?.id ?? "";
  const userLabel = resolveUserLabel(payload.user);

  const guard = await checkPostGuards({
    userId,
    channelId,
    messageTs,
    messageText,
  });
  if (!guard.ok) {
    try {
      await openModal({ triggerId, view: viewForGuardFailure(guard) });
    } catch (error) {
      console.error(
        "[nippo/slack-to-backlog] failed to open warning modal:",
        error,
      );
    }
    return ok();
  }

  const apiKey = await getUserApiKey(userId);

  if (!apiKey) {
    const ctx = encodeContext({
      messageText,
      userLabel,
      channelId,
      messageTs,
    });
    try {
      await openModal({
        triggerId,
        view: buildApiKeyModal(ctx),
      });
    } catch (error) {
      console.error(
        "[nippo/slack-to-backlog] failed to open registration modal:",
        error,
      );
    }
    return ok();
  }

  let viewId: string | undefined;
  try {
    const opened = await openModal({
      triggerId,
      view: buildProcessingView(),
    });
    viewId = opened.id;
  } catch (error) {
    console.error(
      "[nippo/slack-to-backlog] failed to open processing modal:",
      error,
    );
    return ok();
  }

  after(async () => {
    if (!viewId) return;
    try {
      const result = await postNippoComment({
        apiKey,
        messageText,
        userLabel,
      });
      if (result.ok) {
        await recordPosted({ userId, channelId, messageTs });
      }
      await updateModal({ viewId, view: viewForResult(result) });
    } catch (error) {
      console.error("[nippo/slack-to-backlog] backlog post failed:", error);
      await safeUpdateModal({
        viewId,
        view: buildErrorView("Backlogへの投稿に失敗しました。"),
      });
    }
  });

  return ok();
}

async function handleViewSubmission(
  payload: SlackViewSubmissionPayload,
): Promise<Response> {
  const view = payload.view;
  if (!view || view.callback_id !== VIEW_CALLBACK_ID) {
    return ok();
  }

  const userId = payload.user?.id;
  if (!userId) {
    return ok();
  }

  const apiKey =
    view.state?.values?.[APIKEY_BLOCK_ID]?.[APIKEY_ACTION_ID]?.value?.trim();
  if (!apiKey) {
    return Response.json(
      {
        response_action: "errors",
        errors: { [APIKEY_BLOCK_ID]: "APIキーを入力してください" },
      },
      { status: 200 },
    );
  }

  await setUserApiKey(userId, apiKey);

  const ctx = decodeContext(view.private_metadata);
  if (!ctx || !ctx.messageText) {
    return updateResponse(buildRegisteredView());
  }

  const guard = await checkPostGuards({
    userId,
    channelId: ctx.channelId,
    messageTs: ctx.messageTs,
    messageText: ctx.messageText,
  });
  if (!guard.ok) {
    return updateResponse(viewForGuardFailure(guard));
  }

  const viewId = view.id;
  if (viewId) {
    after(async () => {
      try {
        const result = await postNippoComment({
          apiKey,
          messageText: ctx.messageText,
          userLabel: ctx.userLabel,
        });
        if (result.ok) {
          await recordPosted({
            userId,
            channelId: ctx.channelId,
            messageTs: ctx.messageTs,
          });
        }
        await updateModal({ viewId, view: viewForResult(result) });
      } catch (error) {
        console.error(
          "[nippo/slack-to-backlog] post-after-registration failed:",
          error,
        );
        await safeUpdateModal({
          viewId,
          view: buildErrorView("Backlogへの投稿に失敗しました。"),
        });
      }
    });
  }

  return updateResponse(buildProcessingView());
}

// ---------------------------------------------------------------------------
// Slack signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(req: Request, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn(
      "[nippo/slack-to-backlog] SLACK_SIGNING_SECRET not set - skipping verification",
    );
    return true;
  }

  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return false;

  const baseString = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Slack payload types
// ---------------------------------------------------------------------------

type SlackUser = {
  id?: string;
  username?: string;
  name?: string;
};

type SlackMessage = {
  text?: string;
  ts?: string;
};

type SlackChannel = {
  id?: string;
};

type SlackMessageActionPayload = {
  type: "message_action";
  callback_id?: string;
  trigger_id?: string;
  user?: SlackUser;
  message?: SlackMessage;
  channel?: SlackChannel;
};

type SlackViewStateValue = {
  type?: string;
  value?: string;
};

type SlackViewState = {
  values?: Record<string, Record<string, SlackViewStateValue>>;
};

type SlackView = {
  id?: string;
  callback_id?: string;
  state?: SlackViewState;
  private_metadata?: string;
};

type SlackViewSubmissionPayload = {
  type: "view_submission";
  user?: SlackUser;
  view?: SlackView;
};

type SlackPayload =
  | SlackMessageActionPayload
  | SlackViewSubmissionPayload
  | { type?: string };

// ---------------------------------------------------------------------------
// Slack helpers (modal / API)
// ---------------------------------------------------------------------------

type ShortcutContext = {
  messageText: string;
  userLabel: string;
  channelId: string;
  messageTs: string;
};

function encodeContext(ctx: ShortcutContext): string {
  return JSON.stringify(ctx);
}

function decodeContext(raw: string | undefined): ShortcutContext | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const messageText =
      typeof parsed.messageText === "string" ? parsed.messageText : "";
    const userLabel =
      typeof parsed.userLabel === "string" ? parsed.userLabel : "unknown";
    const channelId =
      typeof parsed.channelId === "string" ? parsed.channelId : "";
    const messageTs =
      typeof parsed.messageTs === "string" ? parsed.messageTs : "";
    return { messageText, userLabel, channelId, messageTs };
  } catch {
    return null;
  }
}

type ModalView = Record<string, unknown>;

async function openModal(params: {
  triggerId: string;
  view: ModalView;
}): Promise<{ id: string }> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: params.triggerId, view: params.view }),
  });

  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    view?: { id?: string };
  };
  if (!data.ok || !data.view?.id) {
    throw new Error(`views.open failed: ${data.error ?? "unknown"}`);
  }
  return { id: data.view.id };
}

async function updateModal(params: {
  viewId: string;
  view: ModalView;
}): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");

  const res = await fetch("https://slack.com/api/views.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ view_id: params.viewId, view: params.view }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`views.update failed: ${data.error ?? "unknown"}`);
  }
}

async function safeUpdateModal(params: {
  viewId: string;
  view: ModalView;
}): Promise<void> {
  try {
    await updateModal(params);
  } catch (error) {
    console.error("[nippo/slack-to-backlog] failed to update modal:", error);
  }
}

function updateResponse(view: ModalView): Response {
  return Response.json({ response_action: "update", view }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Modal view builders
// ---------------------------------------------------------------------------

function buildApiKeyModal(privateMetadata: string): ModalView {
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

function buildProcessingView(): ModalView {
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

function buildErrorView(message: string): ModalView {
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

function buildRegisteredView(): ModalView {
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

function buildDuplicateView(): ModalView {
  return {
    type: "modal",
    callback_id: "nippo_warning_duplicate",
    title: { type: "plain_text", text: "投稿済み" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":warning: このメッセージは既にBacklogへ投稿済みです。再投稿は行いません。",
        },
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

function viewForGuardFailure(guard: GuardFailure): ModalView {
  switch (guard.reason) {
    case "empty":
      return buildEmptyMessageView();
    case "duplicate":
      return buildDuplicateView();
    case "rate_limited":
      return buildRateLimitedView(guard.remainingSec);
  }
}

function viewForResult(result: PostResult): ModalView {
  if (result.ok) {
    return buildSuccessView({
      issueKey: result.issueKey,
      summary: result.summary,
      url: result.url,
    });
  }
  return buildNoIssueView(result.today);
}

function resolveUserLabel(user: SlackUser | undefined): string {
  if (!user) return "unknown";
  return user.username ?? user.name ?? user.id ?? "unknown";
}

// ---------------------------------------------------------------------------
// Backlog flow
// ---------------------------------------------------------------------------

type PostResult =
  | { ok: true; issueKey: string; summary: string; url: string }
  | { ok: false; today: Date };

async function postNippoComment(params: {
  apiKey: string;
  messageText: string;
  userLabel: string;
}): Promise<PostResult> {
  const { apiKey, messageText, userLabel } = params;
  const spaceId = requireEnv("BACKLOG_SPACE_ID");

  const projectId = await fetchProjectId({
    spaceId,
    apiKey,
    projectKey: BACKLOG_PROJECT_KEY,
  });

  const today = todayJstDateOnly();
  const issue = await findIssueForToday({
    spaceId,
    apiKey,
    projectId,
    today,
  });

  if (!issue) {
    console.error(
      `[nippo/slack-to-backlog] no matching issue for ${userLabel} on ${formatJstDate(today)}.`,
    );
    return { ok: false, today };
  }

  const content = buildCommentContent(issue.summary, messageText);

  await postBacklogComment({
    spaceId,
    apiKey,
    issueKey: issue.issueKey,
    content,
  });

  return {
    ok: true,
    issueKey: issue.issueKey,
    summary: issue.summary,
    url: `https://${spaceId}.backlog.com/view/${issue.issueKey}`,
  };
}

function buildCommentContent(title: string, messageText: string): string {
  return [`# 日報`, "", normalizeSlackText(messageText), "", "---"].join("\n");
}

function toJst(date: Date): Date {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  return new Date(date.getTime() + jstOffsetMs);
}

function todayJstDateOnly(now: Date = new Date()): Date {
  const jst = toJst(now);
  return new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()),
  );
}

function formatJstDate(date: Date): string {
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

const WEEKLY_TITLE_PATTERN =
  /^(\d{4})年(\d{1,2})月度\s*[(（]\s*(\d{1,2})\/(\d{1,2})\s*[~〜～]\s*(\d{1,2})\/(\d{1,2})\s*[)）]/;

type ParsedWeeklyIssue = {
  issueKey: string;
  summary: string;
  start: Date;
  end: Date;
};

function parseWeeklyTitle(issue: BacklogIssue): ParsedWeeklyIssue | null {
  const m = issue.summary.match(WEEKLY_TITLE_PATTERN);
  if (!m) return null;

  const year = Number(m[1]);
  const startMonth = Number(m[3]);
  const startDay = Number(m[4]);
  const endMonth = Number(m[5]);
  const endDay = Number(m[6]);

  const endYear = endMonth < startMonth ? year + 1 : year;

  const start = new Date(Date.UTC(year, startMonth - 1, startDay));
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));

  return {
    issueKey: issue.issueKey,
    summary: issue.summary,
    start,
    end,
  };
}

function adjacentLabelMonths(
  today: Date,
): Array<{ year: number; month: number }> {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const prev =
    month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const next =
    month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return [prev, { year, month }, next];
}

function normalizeSlackText(text: string): string {
  return text.split("\n").map(normalizeBulletLine).join("\n");
}

const SLACK_INDENT_PER_LEVEL = 3;
const BULLET_PATTERN = /^( *)(•|◦|▪\uFE0E?) +(.*)$/;

function normalizeBulletLine(line: string): string {
  const expanded = line.replace(/\t/g, "    ");
  const match = expanded.match(BULLET_PATTERN);
  if (!match) return line;

  const [, indent, , content] = match;
  const level = Math.floor(indent.length / SLACK_INDENT_PER_LEVEL);
  return `${"  ".repeat(level)}- ${content}`;
}

type BacklogIssue = {
  issueKey: string;
  summary: string;
};

async function fetchProjectId(params: {
  spaceId: string;
  apiKey: string;
  projectKey: string;
}): Promise<number> {
  const { spaceId, apiKey, projectKey } = params;

  const url =
    `https://${spaceId}.backlog.com/api/v2/projects/${encodeURIComponent(projectKey)}` +
    `?apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    throw new Error(
      `Backlog project fetch error ${res.status} (${projectKey}): ${errorText}`,
    );
  }

  const project = (await res.json()) as { id: number };
  return project.id;
}

async function findIssueForToday(params: {
  spaceId: string;
  apiKey: string;
  projectId: number;
  today: Date;
}): Promise<BacklogIssue | null> {
  const { spaceId, apiKey, projectId, today } = params;

  const labels = adjacentLabelMonths(today);
  const fetched = new Map<string, BacklogIssue>();
  for (const { year, month } of labels) {
    const issues = await searchIssuesByKeyword({
      spaceId,
      apiKey,
      projectId,
      keyword: `${year}年${month}月度`,
    });
    for (const issue of issues) {
      fetched.set(issue.issueKey, issue);
    }
  }

  const parsed: ParsedWeeklyIssue[] = [];
  for (const issue of fetched.values()) {
    const p = parseWeeklyTitle(issue);
    if (p) parsed.push(p);
  }

  const todayMs = today.getTime();
  const containing = parsed.filter(
    (p) => p.start.getTime() <= todayMs && todayMs <= p.end.getTime(),
  );

  if (containing.length === 0) {
    return null;
  }

  containing.sort((a, b) => {
    if (b.start.getTime() !== a.start.getTime()) {
      return b.start.getTime() - a.start.getTime();
    }
    const aRange = a.end.getTime() - a.start.getTime();
    const bRange = b.end.getTime() - b.start.getTime();
    return aRange - bRange;
  });

  const best = containing[0];
  return { issueKey: best.issueKey, summary: best.summary };
}

async function searchIssuesByKeyword(params: {
  spaceId: string;
  apiKey: string;
  projectId: number;
  keyword: string;
}): Promise<BacklogIssue[]> {
  const { spaceId, apiKey, projectId, keyword } = params;

  const query = new URLSearchParams();
  query.set("apiKey", apiKey);
  query.append("projectId[]", String(projectId));
  query.set("keyword", keyword);
  query.set("count", "100");

  const url = `https://${spaceId}.backlog.com/api/v2/issues?${query.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    console.warn(
      `[nippo/slack-to-backlog] issue search failed (${res.status}) keyword="${keyword}": ${errorText}`,
    );
    return [];
  }

  return (await res.json()) as BacklogIssue[];
}

async function postBacklogComment(params: {
  spaceId: string;
  apiKey: string;
  issueKey: string;
  content: string;
}): Promise<void> {
  const { spaceId, apiKey, issueKey, content } = params;

  const url = `https://${spaceId}.backlog.com/api/v2/issues/${encodeURIComponent(
    issueKey,
  )}/comments?apiKey=${encodeURIComponent(apiKey)}`;

  const body = new URLSearchParams({ content });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    throw new Error(`Backlog API error ${res.status}: ${errorText}`);
  }
}

// ---------------------------------------------------------------------------
// KV (Upstash Redis)
// ---------------------------------------------------------------------------

const KV_APIKEY_PREFIX = "backlog:apikey:";
const KV_POSTED_PREFIX = "nippo:posted:";
const KV_RATE_PREFIX = "nippo:rate:";

async function getUserApiKey(slackUserId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KV_APIKEY_PREFIX}${slackUserId}`);
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

async function setUserApiKey(
  slackUserId: string,
  apiKey: string,
): Promise<void> {
  await redis.set(`${KV_APIKEY_PREFIX}${slackUserId}`, apiKey);
}

type GuardFailure =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "duplicate" }
  | { ok: false; reason: "rate_limited"; remainingSec: number };

type GuardResult = { ok: true } | GuardFailure;

async function checkPostGuards(params: {
  userId: string;
  channelId: string;
  messageTs: string;
  messageText: string;
}): Promise<GuardResult> {
  if (params.messageText.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (params.channelId && params.messageTs) {
    const key = postedKey(params.channelId, params.messageTs);
    const exists = await redis.get(key);
    if (exists !== null && exists !== undefined) {
      return { ok: false, reason: "duplicate" };
    }
  }

  const rateKey = `${KV_RATE_PREFIX}${params.userId}`;
  const rateExists = await redis.get(rateKey);
  if (rateExists !== null && rateExists !== undefined) {
    const ttl = await redis.ttl(rateKey);
    return {
      ok: false,
      reason: "rate_limited",
      remainingSec: typeof ttl === "number" && ttl > 0 ? ttl : 0,
    };
  }

  return { ok: true };
}

async function recordPosted(params: {
  userId: string;
  channelId: string;
  messageTs: string;
}): Promise<void> {
  const promises: Promise<unknown>[] = [
    redis.set(`${KV_RATE_PREFIX}${params.userId}`, "1", {
      ex: RATE_LIMIT_WINDOW_SEC,
    }),
  ];
  if (params.channelId && params.messageTs) {
    promises.push(
      redis.set(postedKey(params.channelId, params.messageTs), "1", {
        ex: POSTED_TTL_SEC,
      }),
    );
  }
  await Promise.all(promises);
}

function postedKey(channelId: string, messageTs: string): string {
  return `${KV_POSTED_PREFIX}${channelId}:${messageTs}`;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ok(body: Record<string, unknown> = {}): Response {
  return Response.json(body, { status: 200 });
}

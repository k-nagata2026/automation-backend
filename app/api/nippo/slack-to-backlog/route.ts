import { Redis } from "@upstash/redis";

export const runtime = "nodejs";

const SHORTCUT_CALLBACK_ID = "send_nippo_to_backlog";
const VIEW_CALLBACK_ID = "backlog_apikey_register";
const SETUP_COMMAND = "/nippo-setup";
const BACKLOG_PROJECT_KEY = "NIPPO";
const APIKEY_BLOCK_ID = "apikey_block";
const APIKEY_ACTION_ID = "apikey_input";

const redis = Redis.fromEnv();

export async function POST(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();

    const command = formData.get("command");
    if (typeof command === "string" && command.length > 0) {
      return await handleSlashCommand(formData);
    }

    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string" || payloadRaw.length === 0) {
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

async function handleSlashCommand(formData: FormData): Promise<Response> {
  const command = formData.get("command");
  if (command !== SETUP_COMMAND) {
    return ok();
  }

  const triggerId = formData.get("trigger_id");
  if (typeof triggerId !== "string" || triggerId.length === 0) {
    return ok();
  }

  try {
    await openApiKeyModal({ triggerId, privateMetadata: "" });
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
  if (!userId) {
    console.warn("[nippo/slack-to-backlog] missing user id in message_action");
    return ok();
  }

  const messageText = payload.message?.text ?? "";
  const userLabel = resolveUserLabel(payload.user);

  const apiKey = await getUserApiKey(userId);

  if (!apiKey) {
    if (!payload.trigger_id) {
      console.warn(
        "[nippo/slack-to-backlog] missing trigger_id, cannot open modal",
      );
      return ok();
    }
    const ctx = encodeContext({ messageText, userLabel });
    try {
      await openApiKeyModal({
        triggerId: payload.trigger_id,
        privateMetadata: ctx,
      });
    } catch (error) {
      console.error(
        "[nippo/slack-to-backlog] failed to open registration modal:",
        error,
      );
    }
    return ok();
  }

  try {
    await postNippoComment({ apiKey, messageText, userLabel });
  } catch (error) {
    console.error("[nippo/slack-to-backlog] backlog post failed:", error);
  }
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
  if (ctx && ctx.messageText) {
    try {
      await postNippoComment({
        apiKey,
        messageText: ctx.messageText,
        userLabel: ctx.userLabel,
      });
    } catch (error) {
      console.error(
        "[nippo/slack-to-backlog] post-after-registration failed:",
        error,
      );
    }
  }

  return ok();
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
};

type SlackMessageActionPayload = {
  type: "message_action";
  callback_id?: string;
  trigger_id?: string;
  user?: SlackUser;
  message?: SlackMessage;
};

type SlackViewStateValue = {
  type?: string;
  value?: string;
};

type SlackViewState = {
  values?: Record<string, Record<string, SlackViewStateValue>>;
};

type SlackView = {
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
    return { messageText, userLabel };
  } catch {
    return null;
  }
}

async function openApiKeyModal(params: {
  triggerId: string;
  privateMetadata: string;
}): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const view = buildApiKeyModal(params.privateMetadata);

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: params.triggerId, view }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`views.open failed: ${data.error ?? "unknown"}`);
  }
}

function buildApiKeyModal(privateMetadata: string): Record<string, unknown> {
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

function resolveUserLabel(user: SlackUser | undefined): string {
  if (!user) return "unknown";
  return user.username ?? user.name ?? user.id ?? "unknown";
}

// ---------------------------------------------------------------------------
// Backlog flow
// ---------------------------------------------------------------------------

async function postNippoComment(params: {
  apiKey: string;
  messageText: string;
  userLabel: string;
}): Promise<void> {
  const { apiKey, messageText, userLabel } = params;
  const spaceId = requireEnv("BACKLOG_SPACE_ID");

  const projectId = await fetchProjectId({
    spaceId,
    apiKey,
    projectKey: BACKLOG_PROJECT_KEY,
  });

  const candidates = buildTitleCandidates();
  const issue = await findIssueByCandidates({
    spaceId,
    apiKey,
    projectId,
    candidates,
  });

  if (!issue) {
    console.error(
      `[nippo/slack-to-backlog] no matching issue for ${userLabel}. tried: ${candidates.join(" | ")}`,
    );
    return;
  }

  const content = buildCommentContent(issue.summary, messageText);

  await postBacklogComment({
    spaceId,
    apiKey,
    issueKey: issue.issueKey,
    content,
  });
}

function buildCommentContent(title: string, messageText: string): string {
  return [
    `# 日報 ${title}`,
    "",
    normalizeSlackText(messageText),
    "",
    "---",
  ].join("\n");
}

type TitleSpec = { label: string; start: string; end: string };

function buildTitleCandidates(now: Date = new Date()): string[] {
  const jst = toJst(now);
  const monday = startOfWeekMonday(jst);
  const friday = addDays(monday, 4);

  const startYear = monday.getUTCFullYear();
  const startMonth = monday.getUTCMonth() + 1;
  const startDay = monday.getUTCDate();
  const endMonth = friday.getUTCMonth() + 1;
  const endDay = friday.getUTCDate();

  const specs: TitleSpec[] = [];

  if (startMonth === endMonth) {
    specs.push({
      label: `${startMonth}月度`,
      start: `${startMonth}/${startDay}`,
      end: `${endMonth}/${endDay}`,
    });
  } else {
    const startMonthLastDay = lastDayOfMonth(startYear, startMonth);
    specs.push({
      label: `${startMonth}月度`,
      start: `${startMonth}/${startDay}`,
      end: `${startMonth}/${startMonthLastDay}`,
    });
    specs.push({
      label: `${endMonth}月度`,
      start: `${endMonth}/1`,
      end: `${endMonth}/${endDay}`,
    });
    specs.push({
      label: `${startMonth}/${endMonth}月度`,
      start: `${startMonth}/${startDay}`,
      end: `${endMonth}/${endDay}`,
    });
    specs.push({
      label: `${startMonth}月 ${endMonth}月度`,
      start: `${startMonth}/${startDay}`,
      end: `${endMonth}/${endDay}`,
    });
  }

  const tildes = ["~", "〜"];
  const candidates: string[] = [];
  for (const spec of specs) {
    for (const tilde of tildes) {
      candidates.push(
        `${startYear}年${spec.label}(${spec.start}${tilde}${spec.end})`,
      );
    }
  }
  return candidates;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function startOfWeekMonday(date: Date): Date {
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  return addDays(date, -diffToMonday);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toJst(date: Date): Date {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  return new Date(date.getTime() + jstOffsetMs);
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

async function findIssueByCandidates(params: {
  spaceId: string;
  apiKey: string;
  projectId: number;
  candidates: string[];
}): Promise<BacklogIssue | null> {
  const { spaceId, apiKey, projectId, candidates } = params;

  for (const candidate of candidates) {
    const query = new URLSearchParams();
    query.set("apiKey", apiKey);
    query.append("projectId[]", String(projectId));
    query.set("keyword", candidate);
    query.set("count", "100");

    const url = `https://${spaceId}.backlog.com/api/v2/issues?${query.toString()}`;

    const res = await fetch(url);
    if (!res.ok) {
      const errorText = await res.text().catch(() => "<no body>");
      console.warn(
        `[nippo/slack-to-backlog] issue search failed (${res.status}) for "${candidate}": ${errorText}`,
      );
      continue;
    }

    const issues = (await res.json()) as BacklogIssue[];
    const match = issues.find((issue) => issue.summary === candidate);
    if (match) {
      return match;
    }
  }

  return null;
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

const KV_KEY_PREFIX = "backlog:apikey:";

async function getUserApiKey(slackUserId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KV_KEY_PREFIX}${slackUserId}`);
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

async function setUserApiKey(
  slackUserId: string,
  apiKey: string,
): Promise<void> {
  await redis.set(`${KV_KEY_PREFIX}${slackUserId}`, apiKey);
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

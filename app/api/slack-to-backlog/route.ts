export const runtime = "nodejs";

const EXPECTED_CALLBACK_ID = "send_nippo_to_backlog";
const BACKLOG_PROJECT_KEY = "NIPPO";

type SlackUser = {
  id?: string;
  username?: string;
  name?: string;
};

type SlackMessage = {
  text?: string;
};

type SlackShortcutPayload = {
  type?: string;
  callback_id?: string;
  user?: SlackUser;
  message?: SlackMessage;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const payload = await parseSlackPayload(req);

    if (!payload) {
      return ok();
    }

    if (payload.callback_id !== EXPECTED_CALLBACK_ID) {
      return ok();
    }

    const messageText = payload.message?.text ?? "";
    const userLabel = resolveUserLabel(payload.user);

    const spaceId = requireEnv("BACKLOG_SPACE_ID");
    const apiKey = requireEnv("BACKLOG_API_KEY");

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
        `[slack-to-backlog] no matching issue. tried: ${candidates.join(" | ")}`,
      );
      return ok();
    }

    const content = buildCommentContent(issue.summary, messageText, userLabel);

    await postBacklogComment({
      spaceId,
      apiKey,
      issueKey: issue.issueKey,
      content,
    });

    return ok();
  } catch (error) {
    console.error("[slack-to-backlog] failed to handle shortcut:", error);
    return ok();
  }
}

async function parseSlackPayload(
  req: Request,
): Promise<SlackShortcutPayload | null> {
  const formData = await req.formData();
  const payloadRaw = formData.get("payload");

  if (typeof payloadRaw !== "string" || payloadRaw.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payloadRaw);
    if (!isObject(parsed)) {
      return null;
    }
    return parsed as SlackShortcutPayload;
  } catch (error) {
    console.error("[slack-to-backlog] failed to parse payload:", error);
    return null;
  }
}

function resolveUserLabel(user: SlackUser | undefined): string {
  if (!user) return "unknown";
  return user.username ?? user.name ?? user.id ?? "unknown";
}

function buildCommentContent(
  title: string,
  messageText: string,
  userLabel: string,
): string {
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
        `[slack-to-backlog] issue search failed (${res.status}) for "${candidate}": ${errorText}`,
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

import { BACKLOG_PROJECT_KEY, COMMENTS_MAX_PAGES } from "./constants";
import {
  formatJstDate,
  normalizeSlackText,
  requireEnv,
  todayJstDateOnly,
} from "./shared";

type BacklogIssue = {
  issueKey: string;
  summary: string;
};

type BacklogComment = {
  id: number;
  createdUser?: { id?: number };
  created?: string;
};

type ParsedWeeklyIssue = {
  issueKey: string;
  summary: string;
  start: Date;
  end: Date;
};

export type PostResult =
  | { ok: true; issueKey: string; summary: string; url: string }
  | { ok: false; reason: "no_issue"; today: Date }
  | {
      ok: false;
      reason: "already_commented";
      issueKey: string;
      summary: string;
      url: string;
      commentId: number;
    };

const WEEKLY_TITLE_PATTERN =
  /^(\d{4})年(\d{1,2})月度\s*[(（]\s*(\d{1,2})\/(\d{1,2})\s*[~〜～]\s*(\d{1,2})\/(\d{1,2})\s*[)）]/;

export async function postNippoComment(params: {
  apiKey: string;
  messageText: string;
  userLabel: string;
}): Promise<PostResult> {
  const { apiKey, messageText, userLabel } = params;
  const spaceId = requireEnv("BACKLOG_SPACE_ID");

  const [projectId, myUserId] = await Promise.all([
    fetchProjectId({ spaceId, apiKey, projectKey: BACKLOG_PROJECT_KEY }),
    fetchMyselfId({ spaceId, apiKey }),
  ]);

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
    return { ok: false, reason: "no_issue", today };
  }

  const url = `https://${spaceId}.backlog.com/view/${issue.issueKey}`;

  const existingCommentId = await findUsersTodayCommentId({
    spaceId,
    apiKey,
    issueKey: issue.issueKey,
    myUserId,
    today,
  });
  if (existingCommentId !== null) {
    return {
      ok: false,
      reason: "already_commented",
      issueKey: issue.issueKey,
      summary: issue.summary,
      url,
      commentId: existingCommentId,
    };
  }

  const content = buildCommentContent(messageText);
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
    url,
  };
}

function buildCommentContent(messageText: string): string {
  return ["# 日報", "", normalizeSlackText(messageText), "", "---"].join("\n");
}

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

async function fetchMyselfId(params: {
  spaceId: string;
  apiKey: string;
}): Promise<number> {
  const { spaceId, apiKey } = params;
  const url = `https://${spaceId}.backlog.com/api/v2/users/myself?apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    throw new Error(`Backlog myself fetch error ${res.status}: ${errorText}`);
  }

  const me = (await res.json()) as { id?: number };
  if (typeof me.id !== "number") {
    throw new Error("Backlog myself response missing id");
  }
  return me.id;
}

async function fetchIssueCommentsPage(params: {
  spaceId: string;
  apiKey: string;
  issueKey: string;
  maxId?: number;
}): Promise<BacklogComment[]> {
  const { spaceId, apiKey, issueKey, maxId } = params;

  const query = new URLSearchParams();
  query.set("apiKey", apiKey);
  query.set("count", "100");
  query.set("order", "desc");
  if (maxId !== undefined) {
    query.set("maxId", String(maxId));
  }

  const url = `https://${spaceId}.backlog.com/api/v2/issues/${encodeURIComponent(
    issueKey,
  )}/comments?${query.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    throw new Error(
      `Backlog comments fetch error ${res.status} (${issueKey}): ${errorText}`,
    );
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as BacklogComment[]) : [];
}

async function findUsersTodayCommentId(params: {
  spaceId: string;
  apiKey: string;
  issueKey: string;
  myUserId: number;
  today: Date;
}): Promise<number | null> {
  const { spaceId, apiKey, issueKey, myUserId, today } = params;
  let maxId: number | undefined;
  const todayLabel = formatJstDate(today);

  for (let page = 0; page < COMMENTS_MAX_PAGES; page++) {
    const comments = await fetchIssueCommentsPage({
      spaceId,
      apiKey,
      issueKey,
      maxId,
    });
    if (comments.length === 0) return null;

    const matched = comments.find((c) => {
      if (c.createdUser?.id !== myUserId) return false;
      if (typeof c.created !== "string" || c.created.length === 0) return false;
      const createdAt = new Date(c.created);
      if (!Number.isFinite(createdAt.getTime())) return false;
      return formatJstDate(todayJstDateOnly(createdAt)) === todayLabel;
    });
    if (matched && typeof matched.id === "number") {
      return matched.id;
    }

    if (comments.length < 100) return null;

    const last = comments[comments.length - 1];
    if (typeof last.id !== "number") return null;
    maxId = last.id - 1;
  }

  console.warn(
    `[nippo/slack-to-backlog] findUsersTodayCommentId: hit MAX_PAGES (${COMMENTS_MAX_PAGES}) for ${issueKey}; treating as not commented`,
  );
  return null;
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
  if (containing.length === 0) return null;

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

export async function overwriteNippoComment(params: {
  apiKey: string;
  messageText: string;
  issueKey: string;
  commentId: number;
}): Promise<void> {
  const { apiKey, messageText, issueKey, commentId } = params;
  const spaceId = requireEnv("BACKLOG_SPACE_ID");
  const content = buildCommentContent(messageText);

  const url = `https://${spaceId}.backlog.com/api/v2/issues/${encodeURIComponent(
    issueKey,
  )}/comments/${commentId}?apiKey=${encodeURIComponent(apiKey)}`;
  const body = new URLSearchParams({ content });

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "<no body>");
    throw new Error(`Backlog API error ${res.status}: ${errorText}`);
  }
}

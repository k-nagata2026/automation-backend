import crypto from "node:crypto";

import { after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = "claude-opus-4-7";
const MAX_DIFF_BYTES = 180_000;
// zero-accel.slack.com の #claude_code_review チャンネル
const SLACK_CHANNEL_ID = "C0B2JAS7NLR";

// ---------- Types ----------

type PrUser = { login: string };

type PrInfo = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: PrUser;
};

type PullRequestPayload = {
  action: string;
  pull_request: PrInfo;
  repository: { full_name: string };
  installation: { id: number };
};

type ClaudeResponse = {
  review: string;
  summary: string;
};

// ---------- Handler ----------

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const event = req.headers.get("x-github-event") ?? "";
  const sig = req.headers.get("x-hub-signature-256") ?? "";

  let webhookSecret: string;
  try {
    webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  } catch (e) {
    console.error(e);
    return json({ error: "server misconfigured" }, 500);
  }

  if (!verifyWebhookSignature(webhookSecret, rawBody, sig)) {
    return json({ error: "invalid signature" }, 401);
  }

  if (event === "ping") {
    return json({ ok: true, pong: true });
  }
  if (event !== "pull_request") {
    return json({ ok: true, ignored: `event=${event}` });
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody) as PullRequestPayload;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const targetActions = new Set(["opened", "synchronize", "reopened"]);
  if (!targetActions.has(payload.action)) {
    return json({ ok: true, ignored: `action=${payload.action}` });
  }
  if (payload.pull_request.draft) {
    return json({ ok: true, ignored: "draft" });
  }

  let env: ReviewEnv;
  try {
    env = loadEnv();
  } catch (e) {
    console.error(e);
    return json({ error: "server misconfigured" }, 500);
  }

  const repo = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const installationId = payload.installation.id;
  const pr = payload.pull_request;

  after(async () => {
    try {
      const appJwt = generateAppJwt(env.appId, env.privateKey);
      const installationToken = await getInstallationToken(appJwt, installationId);

      const diff = await fetchDiff(repo, prNumber, installationToken);
      const result = await runReview({
        diff,
        pr,
        anthropicKey: env.anthropicKey,
      });

      await postPrComment({
        repo,
        prNumber,
        token: installationToken,
        body: result.review,
      });
      await postSlack({
        token: env.slackToken,
        channel: SLACK_CHANNEL_ID,
        pr,
        repo,
        summary: result.summary,
      });
    } catch (e) {
      console.error("[pr-review] background failure", e);
    }
  });

  return json({ ok: true, queued: true });
}

// ---------- Env ----------

type ReviewEnv = {
  appId: string;
  privateKey: string;
  anthropicKey: string;
  slackToken: string;
};

function loadEnv(): ReviewEnv {
  return {
    appId: required("GITHUB_APP_ID"),
    privateKey: loadPrivateKey(),
    anthropicKey: required("ANTHROPIC_API_KEY"),
    slackToken: required("SLACK_BOT_TOKEN"),
  };
}

function loadPrivateKey(): string {
  const raw = required("GITHUB_APP_PRIVATE_KEY");
  // PEM 直貼り（Vercel UI で改行可）または base64 のどちらでも受ける
  if (raw.includes("BEGIN")) {
    return raw.replace(/\\n/g, "\n");
  }
  return Buffer.from(raw, "base64").toString("utf-8");
}

// ---------- GitHub App auth ----------

function verifyWebhookSignature(secret: string, body: string, sig: string): boolean {
  if (!sig.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function generateAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function getInstallationToken(
  appJwt: string,
  installationId: number,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "automation-backend-pr-review",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`installation token ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

// ---------- GitHub data access ----------

async function fetchDiff(
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    { headers: ghHeaders(token, "application/vnd.github.v3.diff") },
  );
  if (!res.ok) {
    throw new Error(`fetchDiff ${res.status}: ${await res.text()}`);
  }
  return await res.text();
}

async function postPrComment(args: {
  repo: string;
  prNumber: number;
  token: string;
  body: string;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${args.repo}/issues/${args.prNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(args.token, "application/vnd.github+json"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: args.body }),
    },
  );
  if (!res.ok) {
    throw new Error(`postPrComment ${res.status}: ${await res.text()}`);
  }
}

function ghHeaders(token: string, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "automation-backend-pr-review",
  };
}

// ---------- Anthropic ----------

async function runReview(args: {
  diff: string;
  pr: PrInfo;
  anthropicKey: string;
}): Promise<ClaudeResponse> {
  const truncated =
    args.diff.length > MAX_DIFF_BYTES
      ? args.diff.slice(0, MAX_DIFF_BYTES) + "\n\n[... diff truncated ...]"
      : args.diff;

  const systemPrompt = [
    "あなたは熟練のコードレビュアーです。",
    "対象リポジトリは Shopify / ecforce 系の Liquid テーマを多く含みます。",
    "Liquid タグ・フィルタの構文、変数名タイポ、終了タグの閉じ忘れを特に注意してください。",
    "レビューは日本語で行い、以下の JSON 形式のみで出力してください。",
    "余計な説明・コードフェンスは含めないこと。",
    "{",
    '  "review": "PR コメントとして投稿される Markdown 本文",',
    '  "summary": "Slack 用の短いサマリ。日本語、5 行以内、絵文字なし"',
    "}",
    "review の構成:",
    "- 観点: バグ / セキュリティ / パフォーマンス / 可読性 / Liquid 構文",
    "- 良い点と改善点を分けて記述",
    "- 各指摘に重大度ラベル (blocker / major / minor / nit) を付与",
    "- 指摘箇所はファイルパスを明記",
    "summary の構成:",
    "- 1 行目: 全体評価 (LGTM / 要修正 / ブロッカーあり 等)",
    "- 残り: 主な指摘 3 件まで（無ければ省略）",
  ].join("\n");

  const userPrompt = [
    `# PR: ${args.pr.title}`,
    `Author: @${args.pr.user.login}`,
    `URL: ${args.pr.html_url}`,
    "",
    "# Diff",
    "```diff",
    truncated,
    "```",
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content
    .map((c) => (c.type === "text" ? c.text ?? "" : ""))
    .join("")
    .trim();

  return parseClaudeJson(text);
}

function parseClaudeJson(text: string): ClaudeResponse {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as Partial<ClaudeResponse>;
    if (typeof parsed.review === "string" && typeof parsed.summary === "string") {
      return { review: parsed.review, summary: parsed.summary };
    }
  } catch {
    // fallthrough
  }
  return {
    review: text,
    summary: "（サマリ抽出失敗。PR コメントを参照してください）",
  };
}

// ---------- Slack ----------

async function postSlack(args: {
  token: string;
  channel: string;
  pr: PrInfo;
  repo: string;
  summary: string;
}): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      text: `Claude review: ${args.repo} <${args.pr.html_url}|#${args.pr.number} ${args.pr.title}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Claude PR Review* — \`${args.repo}\`\n<${args.pr.html_url}|#${args.pr.number} ${args.pr.title}>\nby \`${args.pr.user.login}\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "```\n" + args.summary + "\n```",
          },
        },
      ],
    }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`slack chat.postMessage failed: ${data.error}`);
  }
}

// ---------- utils ----------

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is not set`);
  return v;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

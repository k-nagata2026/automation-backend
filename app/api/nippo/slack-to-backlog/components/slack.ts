import { createHmac, timingSafeEqual } from "node:crypto";

import {
  SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_VERSION,
} from "./constants";
import { isObject, requireEnv } from "./shared";

export type SlackUser = {
  id?: string;
  username?: string;
  name?: string;
};

type SlackMessage = {
  text?: string;
};

export type SlackMessageActionPayload = {
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

export type SlackView = {
  id?: string;
  callback_id?: string;
  state?: SlackViewState;
  private_metadata?: string;
};

export type SlackViewSubmissionPayload = {
  type: "view_submission";
  user?: SlackUser;
  view?: SlackView;
};

export type SlackPayload =
  | SlackMessageActionPayload
  | SlackViewSubmissionPayload
  | { type?: string };

export type ShortcutContext = {
  messageText: string;
  userLabel: string;
};

export type OverwriteContext = {
  messageText: string;
  issueKey: string;
  commentId: number;
  summary: string;
  url: string;
};

export type ModalView = Record<string, unknown>;

export function verifySlackSignature(req: Request, rawBody: string): boolean {
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

export function encodeContext(ctx: ShortcutContext): string {
  return JSON.stringify(ctx);
}

export function decodeContext(raw: string | undefined): ShortcutContext | null {
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

export function encodeOverwriteContext(ctx: OverwriteContext): string {
  return JSON.stringify(ctx);
}

export function decodeOverwriteContext(
  raw: string | undefined,
): OverwriteContext | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (
      typeof parsed.messageText !== "string" ||
      typeof parsed.issueKey !== "string" ||
      typeof parsed.commentId !== "number" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return null;
    }
    return {
      messageText: parsed.messageText,
      issueKey: parsed.issueKey,
      commentId: parsed.commentId,
      summary: parsed.summary,
      url: parsed.url,
    };
  } catch {
    return null;
  }
}

export async function openModal(params: {
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

export async function updateModal(params: {
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

export async function safeUpdateModal(params: {
  viewId: string;
  view: ModalView;
}): Promise<void> {
  try {
    await updateModal(params);
  } catch (error) {
    console.error("[nippo/slack-to-backlog] failed to update modal:", error);
  }
}

export function updateResponse(view: ModalView): Response {
  return Response.json({ response_action: "update", view }, { status: 200 });
}

export function resolveUserLabel(user: SlackUser | undefined): string {
  if (!user) return "unknown";
  return user.username ?? user.name ?? user.id ?? "unknown";
}

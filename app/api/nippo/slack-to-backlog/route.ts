import { after } from "next/server";

import { overwriteNippoComment, postNippoComment } from "./components/backlog";
import {
  APIKEY_ACTION_ID,
  APIKEY_BLOCK_ID,
  OVERWRITE_CALLBACK_ID,
  SETUP_COMMAND,
  SHORTCUT_CALLBACK_ID,
  VIEW_CALLBACK_ID,
} from "./components/constants";
import {
  checkPostGuards,
  getUserApiKey,
  recordRateLimit,
  setUserApiKey,
} from "./components/kv";
import {
  decodeContext,
  decodeOverwriteContext,
  encodeContext,
  encodeOverwriteContext,
  openModal,
  resolveUserLabel,
  safeUpdateModal,
  type SlackMessageActionPayload,
  type SlackPayload,
  type SlackViewSubmissionPayload,
  updateModal,
  updateResponse,
  verifySlackSignature,
} from "./components/slack";
import { isObject, ok } from "./components/shared";
import {
  buildApiKeyModal,
  buildErrorView,
  buildProcessingView,
  buildRegisteredView,
  viewForGuardFailure,
  viewForResult,
} from "./components/views";

export const runtime = "nodejs";

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
    if (!payloadRaw) return ok();

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

async function handleSlashCommand(params: URLSearchParams): Promise<Response> {
  const command = params.get("command");
  if (command !== SETUP_COMMAND) return ok();

  const triggerId = params.get("trigger_id");
  if (!triggerId) return ok();

  try {
    await openModal({
      triggerId,
      view: buildApiKeyModal(""),
    });
  } catch (error) {
    console.error("[nippo/slack-to-backlog] failed to open setup modal:", error);
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
  if (payload.callback_id !== SHORTCUT_CALLBACK_ID) return ok();

  const userId = payload.user?.id;
  const triggerId = payload.trigger_id;
  if (!userId || !triggerId) {
    console.warn(
      "[nippo/slack-to-backlog] missing user id or trigger id in message_action",
    );
    return ok();
  }

  const messageText = payload.message?.text ?? "";
  const userLabel = resolveUserLabel(payload.user);

  const guard = await checkPostGuards({ userId, messageText });
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
    const ctx = encodeContext({ messageText, userLabel });
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
        await recordRateLimit(userId);
      }
      const overwriteMetadata =
        !result.ok && result.reason === "already_commented"
          ? encodeOverwriteContext({
              messageText,
              issueKey: result.issueKey,
              commentId: result.commentId,
              summary: result.summary,
              url: result.url,
            })
          : undefined;
      await updateModal({
        viewId,
        view: viewForResult(result, overwriteMetadata),
      });
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
  if (!view) return ok();

  if (view.callback_id === VIEW_CALLBACK_ID) {
    return await handleApiKeyRegistration(payload);
  }
  if (view.callback_id === OVERWRITE_CALLBACK_ID) {
    return await handleOverwriteSubmission(payload);
  }
  return ok();
}

async function handleApiKeyRegistration(
  payload: SlackViewSubmissionPayload,
): Promise<Response> {
  const view = payload.view;
  if (!view) return ok();

  const userId = payload.user?.id;
  if (!userId) return ok();

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
          await recordRateLimit(userId);
        }
        const overwriteMetadata =
          !result.ok && result.reason === "already_commented"
            ? encodeOverwriteContext({
                messageText: ctx.messageText,
                issueKey: result.issueKey,
                commentId: result.commentId,
                summary: result.summary,
                url: result.url,
              })
            : undefined;
        await updateModal({
          viewId,
          view: viewForResult(result, overwriteMetadata),
        });
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

async function handleOverwriteSubmission(
  payload: SlackViewSubmissionPayload,
): Promise<Response> {
  const view = payload.view;
  if (!view) return ok();

  const userId = payload.user?.id;
  if (!userId) return ok();

  const ctx = decodeOverwriteContext(view.private_metadata);
  if (!ctx) {
    return updateResponse(
      buildErrorView("上書き対象の情報を取得できませんでした。"),
    );
  }

  const apiKey = await getUserApiKey(userId);
  if (!apiKey) {
    return updateResponse(
      buildErrorView(
        "Backlog APIキーが登録されていません。`/nippo-setup` で再登録してください。",
      ),
    );
  }

  const viewId = view.id;
  if (viewId) {
    after(async () => {
      try {
        await overwriteNippoComment({
          apiKey,
          messageText: ctx.messageText,
          issueKey: ctx.issueKey,
          commentId: ctx.commentId,
        });
        await recordRateLimit(userId);
        await updateModal({
          viewId,
          view: viewForResult({
            ok: true,
            issueKey: ctx.issueKey,
            summary: ctx.summary,
            url: ctx.url,
          }),
        });
      } catch (error) {
        console.error(
          "[nippo/slack-to-backlog] backlog overwrite failed:",
          error,
        );
        await safeUpdateModal({
          viewId,
          view: buildErrorView("Backlogコメントの上書きに失敗しました。"),
        });
      }
    });
  }

  return updateResponse(buildProcessingView());
}

import { Redis } from "@upstash/redis";

import { RATE_LIMIT_WINDOW_SEC } from "./constants";

const redis = Redis.fromEnv();

const KV_APIKEY_PREFIX = "backlog:apikey:";
const KV_RATE_PREFIX = "nippo:rate:";

export type GuardFailure =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "rate_limited"; remainingSec: number };

export type GuardResult = { ok: true } | GuardFailure;

export async function getUserApiKey(slackUserId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KV_APIKEY_PREFIX}${slackUserId}`);
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

export async function setUserApiKey(
  slackUserId: string,
  apiKey: string,
): Promise<void> {
  await redis.set(`${KV_APIKEY_PREFIX}${slackUserId}`, apiKey);
}

export async function checkPostGuards(params: {
  userId: string;
  messageText: string;
}): Promise<GuardResult> {
  if (params.messageText.trim().length === 0) {
    return { ok: false, reason: "empty" };
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

export async function recordRateLimit(slackUserId: string): Promise<void> {
  await redis.set(`${KV_RATE_PREFIX}${slackUserId}`, "1", {
    ex: RATE_LIMIT_WINDOW_SEC,
  });
}

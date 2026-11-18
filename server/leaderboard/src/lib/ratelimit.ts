import type { Env } from "../env";
import { LIMITS } from "../limits";
import { ApiError } from "./http";
import { sha256Hex } from "./crypto";

// Fixed-window counters in D1. Works identically in local dev, tests and production.
// For very high traffic the Workers Rate Limiting binding is cheaper (no D1 write per request);
// see README "Rate limiting".

export type Bucket = keyof typeof LIMITS.rate;

export async function hit(env: Env, key: string, bucket: Bucket, now: number): Promise<void> {
  const [max, windowSec] = LIMITS.rate[bucket];
  const nowSec = Math.floor(now / 1000);
  const window = nowSec - (nowSec % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key, window) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(`${key}:${bucket}`, window)
    .first<{ count: number }>();
  if (row && row.count > max) {
    const retry = window + windowSec - nowSec;
    throw new ApiError(429, "rate_limited", "Too many requests, slow down", { "Retry-After": String(Math.max(1, retry)) }, {
      bucket,
      retryAfterSeconds: Math.max(1, retry),
    });
  }
}

/** Raw IPs are never stored: the key is a salted hash. */
export async function ipKey(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const hash = await sha256Hex(`${env.IP_HASH_SALT ?? "spechy-leaderboard"}|${ip}`);
  return `ip:${hash.slice(0, 32)}`;
}

export const tokenKey = (playerId: string) => `tok:${playerId}`;

import "server-only";
import { isIP } from "node:net";
import { statement, getDb } from "./db";
import { tokenHash } from "./security";
import { AppError } from "./errors";
import { maintainDatabase } from "./db-maintenance";

/** Trust only a configured header overwritten by an ingress that clients cannot bypass. */
let warnedSharedBucket = false;
export function clientKey(source: Request | Headers): string {
  const headers = source instanceof Headers ? source : source.headers;
  const header = process.env.ELYTRA_TRUSTED_IP_HEADER?.toLowerCase();
  if (!header) {
    if (!warnedSharedBucket) {
      warnedSharedBucket = true;
      console.warn("ELYTRA_TRUSTED_IP_HEADER is not set: all anonymous clients share one rate-limit key, so those limits act as site-wide flood ceilings.");
    }
    return "untrusted";
  }
  if (!["cf-connecting-ip", "x-real-ip", "x-forwarded-for"].includes(header)) throw new Error("Invalid ELYTRA_TRUSTED_IP_HEADER");
  const raw = headers.get(header)?.split(",")[0]?.trim();
  return raw && isIP(raw) ? raw.toLowerCase() : "untrusted";
}

/** Without a trusted proxy every anonymous client shares the "untrusted" key, so buckets keyed by
 * it widen until only a sustained flood trips them; ordinary traffic never competes for one. */
const SHARED_CEILING = 10;
export function sharedBucketScale(source: Request | Headers): number {
  return clientKey(source) === "untrusted" ? SHARED_CEILING : 1;
}

function clearLimit(key: string): void { statement("DELETE FROM api_rate_limits WHERE key=?").run(tokenHash(key)); }

/** Increase a counter and report where it stands, without rejecting anyone. */
function countLimit(key: string, limit: number, windowMs: number): { count: number; over: boolean; resetAt: number } {
  const now = Date.now();
  maintainDatabase(getDb(), now);
  // One atomic statement: no read-modify-write race and no rollback on rejection.
  const row = statement(`INSERT INTO api_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN api_rate_limits.reset_at<=? THEN 1 ELSE MIN(api_rate_limits.count+1,?) END,
    reset_at=CASE WHEN api_rate_limits.reset_at<=? THEN excluded.reset_at ELSE api_rate_limits.reset_at END
    RETURNING count,reset_at`).get(tokenHash(key), now + windowMs, now, limit + 1, now) as { count: number; reset_at: number };
  return { count: row.count, over: row.count > limit, resetAt: row.reset_at };
}

export function rateLimit(key: string, limit: number, windowMs: number): { remaining: number; reset: number } {
  const counted = countLimit(key, limit, windowMs);
  if (counted.over) throw new AppError(429, "rate_limited", "Too many requests. Try again later.", { retryAfter: Math.max(1, Math.ceil((counted.resetAt - Date.now()) / 1000)) });
  return { remaining: limit - counted.count, reset: Math.ceil(counted.resetAt / 1000) };
}

export type AuthAttempt = { throttleFailed: () => void; clear: () => void };
/** Track a sign-in attempt before verification, but only wrong credentials can ever be throttled,
 * and a successful sign-in clears both counters. Brute force against one account still stops at
 * the per-username limit; a flood of junk attempts can no longer lock the real owner out of their
 * own account. The password-hashing capacity limit bounds CPU burn meanwhile. */
export function trackAuthAttempt(source: Request | Headers, username: string): AuthAttempt {
  const ip = countLimit(`login:${clientKey(source)}`, 60 * sharedBucketScale(source), 60000);
  const account = countLimit(`login:${username.toLowerCase()}`, 10, 15 * 60000);
  return {
    throttleFailed: () => {
      if (!ip.over && !account.over) return;
      const resetAt = Math.max(ip.over ? ip.resetAt : 0, account.over ? account.resetAt : 0);
      throw new AppError(429, "rate_limited", "Too many failed sign-in attempts. Try again later.", { retryAfter: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) });
    },
    clear: () => { clearLimit(`login:${clientKey(source)}`); clearLimit(`login:${username.toLowerCase()}`); },
  };
}
export function limitRegistration(source: Request | Headers): void { rateLimit(`registration:${clientKey(source)}`, 20 * sharedBucketScale(source), 3600000); }

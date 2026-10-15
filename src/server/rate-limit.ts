import "server-only";
import { isIP } from "node:net";
import { statement, getDb } from "./db";
import { tokenHash } from "./security";
import { AppError } from "./errors";
import { maintainDatabase } from "./db-maintenance";

/** Trust only a configured header overwritten by an ingress that clients cannot bypass. */
export function clientKey(source: Request | Headers): string {
  const headers = source instanceof Headers ? source : source.headers;
  const header = process.env.ELYTRA_TRUSTED_IP_HEADER?.toLowerCase();
  if (!header) return "untrusted";
  if (!["cf-connecting-ip", "x-real-ip", "x-forwarded-for"].includes(header)) throw new Error("Invalid ELYTRA_TRUSTED_IP_HEADER");
  const raw = headers.get(header)?.split(",")[0]?.trim();
  return raw && isIP(raw) ? raw.toLowerCase() : "untrusted";
}
export function rateLimit(key: string, limit: number, windowMs: number): { remaining: number; reset: number } {
  const now = Date.now();
  maintainDatabase(getDb(), now);
  // One atomic statement: no read-modify-write race and no rollback on rejection.
  const row = statement(`INSERT INTO api_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN api_rate_limits.reset_at<=? THEN 1 ELSE MIN(api_rate_limits.count+1,?) END,
    reset_at=CASE WHEN api_rate_limits.reset_at<=? THEN excluded.reset_at ELSE api_rate_limits.reset_at END
    RETURNING count,reset_at`).get(tokenHash(key), now + windowMs, now, limit + 1, now) as { count: number; reset_at: number };
  if (row.count > limit) throw new AppError(429, "rate_limited", "Too many requests. Try again later.", { retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) });
  return { remaining: limit - row.count, reset: Math.ceil(row.reset_at / 1000) };
}
export function limitAuthAttempt(headers: Headers, username: string): void {
  rateLimit(`login:${clientKey(headers)}`, 60, 60000);
  rateLimit(`login:${username.toLowerCase()}`, 10, 15 * 60000);
}
export function limitRegistration(headers: Headers): void { rateLimit(`registration:${clientKey(headers)}`, 20, 3600000); }

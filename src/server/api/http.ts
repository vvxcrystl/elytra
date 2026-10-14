import "server-only";
import type { Viewer, Page } from "../../lib/types";
import { AppError } from "../errors";
import { viewerForToken } from "../data/core";
import { one, run } from "../data/core";
import { tokenHash } from "../security";
import { transaction } from "../db";
import type { PageOptions } from "../data/pagination";

export type Field = { type: "string" | "boolean" | "array" | "object"; required?: boolean; minLength?: number; maxLength?: number; pattern?: string; enum?: string[]; nullable?: boolean; maxItems?: number; items?: Field; fields?: Fields };
export type Fields = Record<string, Field>;
export type Input = Record<string, unknown>;
export type ApiContext = {
  request: Request; url: URL; params: Record<string, string>; viewer: Viewer | null;
  token: string | null; body: Input; headers: Headers;
};
export const idField: Field = { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" };
export const stringValue = (input: Input, key: string, fallback = "") => typeof input[key] === "string" ? input[key] as string : fallback;
export const requiredViewer = (ctx: ApiContext): Viewer => {
  if (!ctx.viewer) throw new AppError(401, "unauthorized", "Authentication required");
  return ctx.viewer;
};
export function data(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json({ data: value }, { status, headers });
}
export function page<T>(value: Page<T>): Response {
  return Response.json({ data: value.items, meta: { nextCursor: value.nextCursor } });
}
export function pageOptions(ctx: ApiContext): PageOptions {
  const raw = ctx.url.searchParams.get("limit");
  if (raw !== null && (!/^[1-9]\d*$/.test(raw) || Number(raw) > 100)) throw new AppError(400, "validation_error", "limit must be an integer between 1 and 100");
  const cursor = ctx.url.searchParams.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 1000)) throw new AppError(400, "invalid_cursor", "Invalid cursor");
  return { limit: raw ? Number(raw) : 20, cursor };
}
export function enumQuery<T extends string>(ctx: ApiContext, name: string, allowed: readonly T[], fallback: T): T {
  const value = ctx.url.searchParams.get(name) ?? fallback;
  if (!allowed.includes(value as T)) throw new AppError(400, "validation_error", `${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}
export function queryText(ctx: ApiContext, name: string, maxLength: number, required = false): string {
  const value = ctx.url.searchParams.get(name)?.trim() ?? "";
  if ((required && !value) || value.length > maxLength) throw new AppError(400, "validation_error", `${name} ${required ? "is required and " : ""}must be at most ${maxLength} characters`);
  return value;
}
export function validate(value: unknown, fields: Fields): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "validation_error", "Request body must be a JSON object");
  const input = value as Input, errors: Record<string, string> = Object.create(null);
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) errors[key] = "Unknown field";
  function fieldError(v: unknown, rule: Field): string | null {
    if (v === null && rule.nullable) return null;
    if (rule.type === "object") {
      try { validate(v, rule.fields ?? {}); } catch { return "Invalid object fields"; }
    } else if (rule.type === "array") {
      if (!Array.isArray(v)) return "Expected an array";
      if (v.length > (rule.maxItems ?? 100)) return `Add at most ${rule.maxItems ?? 100} items`;
      if (rule.items && v.some(item => fieldError(item, rule.items!))) return "Invalid array item";
    } else if (typeof v !== rule.type) return `Expected ${rule.type}`;
    if (typeof v === "string") {
      const length = [...v].length;
      if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity)) return `Length must be ${rule.minLength ?? 0}–${rule.maxLength ?? "unlimited"}`;
      if (rule.pattern && !new RegExp(rule.pattern).test(v)) return "Invalid format";
      if (rule.enum && !rule.enum.includes(v)) return `Expected one of: ${rule.enum.join(", ")}`;
    }
    return null;
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (input[key] === undefined) { if (rule.required) errors[key] = "Required"; continue; }
    const error = fieldError(input[key], rule); if (error) errors[key] = error;
  }
  if (Object.keys(errors).length) throw new AppError(400, "validation_error", "Invalid request fields", errors);
  return input;
}
export async function boundedBytes(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > max) throw new AppError(413, "payload_too_large", "Request body is too large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new AppError(413, "payload_too_large", "Request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function jsonBody(request: Request, fields: Fields, maxBytes = 64 * 1024): Promise<Input> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError(415, "unsupported_media_type", "Use Content-Type: application/json");
  const bytes = await boundedBytes(request, maxBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AppError(400, "invalid_json", "Malformed JSON body"); }
  return validate(value, fields);
}
export function credentials(request: Request): { token: string | null; viewer: Viewer | null; bearer: boolean } {
  const auth = request.headers.get("authorization");
  const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("elytra_session="))?.slice("elytra_session=".length) ?? null;
  if (auth !== null) {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(auth);
    if (!match) throw new AppError(401, "unauthorized", "Invalid bearer token");
    const viewer = viewerForToken(match[1]);
    if (!viewer) throw new AppError(401, "unauthorized", "Invalid or expired bearer token");
    return { token: match[1], viewer, bearer: true };
  }
  return { token: cookie, viewer: cookie ? viewerForToken(cookie) : null, bearer: false };
}
/** JSON content types plus Origin/Sec-Fetch-Site checks protect cookie-authenticated writes. */
export function checkOrigin(request: Request, bearer: boolean): void {
  if (bearer || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  const expected = process.env.ELYTRA_PUBLIC_ORIGIN || new URL(request.url).origin;
  if ((origin && origin !== expected) || site === "cross-site") throw new AppError(403, "invalid_origin", "Cross-origin mutations are not allowed");
}
export function sessionCookie(token: string, maxAge: number, expires?: Date): string {
  return `elytra_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${expires ? `; Expires=${expires.toUTCString()}` : ""}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function rateLimit(key: string, limit: number, windowMs: number): { remaining: number; reset: number } {
  return transaction(() => {
    const now = Date.now();
    run("DELETE FROM api_rate_limits WHERE reset_at<=?", now);
    run(`INSERT INTO api_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=api_rate_limits.count+1`, tokenHash(key), now + windowMs);
    const row = one<{ count: number; reset_at: number }>("SELECT count,reset_at FROM api_rate_limits WHERE key=?", tokenHash(key))!;
    if (row.count > limit) throw new AppError(429, "rate_limited", "Too many requests. Try again later.", { retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) });
    return { remaining: limit - row.count, reset: Math.ceil(row.reset_at / 1000) };
  });
}

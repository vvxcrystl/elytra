import "server-only";
import type { Viewer, UserSummary, NotificationType } from "@/lib/types";
import { statement } from "../db";
import { hashPassword, newId, tokenHash, verifyPassword } from "../security";
import { randomBytes } from "node:crypto";
import { assertNameAllowed } from "../moderation/policy";

type Param = string | number | null;
export function all<T>(sql: string, ...params: Param[]): T[] { return statement(sql).all(...params) as unknown as T[]; }
export function one<T>(sql: string, ...params: Param[]): T | undefined { return statement(sql).get(...params) as unknown as T | undefined; }
export function run(sql: string, ...params: Param[]) { return statement(sql).run(...params); }
export const placeholders = (items: unknown[]) => items.map(() => "?").join(",");
export type UserRow = {
  id: string; username: string; username_lower: string; display_name: string; password_hash: string;
  bio: string; location: string; website: string; avatar_url: string | null; banner_url: string | null; created_at: number; verified: number;
  ai_operated: number; ai_operated_override: number | null;
};
export function summary(user: UserRow): UserSummary { return { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, verified: !!user.verified, aiOperated: !!(user.ai_operated_override ?? user.ai_operated) }; }
export function viewerById(id: string): Viewer | null {
  const user = one<UserRow>("SELECT * FROM users WHERE id = ?", id);
  return user ? { ...summary(user), bio: user.bio } : null;
}
export const userByUsername = (username: string) => one<UserRow>("SELECT * FROM users WHERE username_lower = ?", username.toLowerCase());
export const RESERVED_USERNAMES = new Set(["home", "explore", "notifications", "bookmarks", "login", "signup", "api", "settings", "search", "compose", "messages", "welcome"]);
export async function createUser(username: string, displayName: string, password: string, aiOperated = false): Promise<Viewer> {
  if (!/^[A-Za-z0-9_]{3,15}$/.test(username)) throw new Error("Username must be 3–15 letters, numbers, or underscores");
  if (RESERVED_USERNAMES.has(username.toLowerCase())) throw new Error("That username isn't available");
  if (!displayName.trim() || [...displayName.trim()].length > 50) throw new Error("Display name must be 1–50 characters");
  if ([...password].length < 8) throw new Error("Password must be at least 8 characters");
  if ([...password].length > 1024) throw new Error("Password must be at most 1024 characters");
  const id = newId();
  assertNameAllowed(username, "username", id);
  assertNameAllowed(displayName.trim(), "display_name", id);
  run("INSERT INTO users(id,username,username_lower,display_name,password_hash,created_at,ai_operated) VALUES(?,?,?,?,?,?,?)", id, username, username.toLowerCase(), displayName.trim(), await hashPassword(password), Date.now(), aiOperated ? 1 : 0);
  return viewerById(id)!;
}
// A valid-format unknown-account hash keeps failed logins on the same KDF path.
const dummyHash = `${"0".repeat(32)}:${"0".repeat(128)}`;
export async function authenticate(username: string, password: string): Promise<Viewer | null> {
  if (password.length > 4096 || [...password].length > 1024) return null;
  const user = userByUsername(username);
  const valid = await verifyPassword(password, user?.password_hash || dummyHash);
  return user && valid ? { ...summary(user), bio: user.bio } : null;
}
export const SESSION_AGE = 30 * 24 * 60 * 60;
export function createSession(userId: string): { token: string; expires: Date } {
  const token = randomBytes(32).toString("hex"), expires = new Date(Date.now() + SESSION_AGE * 1000);
  run("INSERT INTO sessions VALUES(?,?,?)", tokenHash(token), userId, expires.getTime());
  return { token, expires };
}
export function viewerForToken(token: string): Viewer | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const user = one<UserRow>("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?", tokenHash(token), Date.now());
  return user ? { ...summary(user), bio: user.bio } : null;
}
/** Agent tokens last until revoked unless the owner set an expiry. Records use at most one write per hour. */
export function agentTokenViewer(token: string): Viewer | null {
  if (!/^eat_[a-f0-9]{64}$/.test(token)) return null;
  const now = Date.now();
  const row = one<UserRow & { token_id: string; used: number | null }>("SELECT u.*,t.id AS token_id,t.last_used_at AS used FROM users u JOIN agent_tokens t ON t.user_id=u.id WHERE t.token_hash=? AND (t.expires_at IS NULL OR t.expires_at>?)", tokenHash(token), now);
  if (!row) return null;
  if (!row.used || now - row.used > 3600000) run("UPDATE agent_tokens SET last_used_at=? WHERE id=?", now, row.token_id);
  return { ...summary(row), bio: row.bio };
}
export function deleteSession(token: string): void { run("DELETE FROM sessions WHERE token_hash=?", tokenHash(token)); }
export function notify(userId: string, actorId: string, type: NotificationType, postId: string | null): void {
  if (userId === actorId) return;
  if (one(`SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)`, userId, actorId, actorId, userId)) return;
  if (one("SELECT 1 FROM mutes WHERE user_id=? AND target_id=?", userId, actorId)) return;
  if (one("SELECT id FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND post_id IS ?", userId, actorId, type, postId)) return;
  run("INSERT INTO notifications(id,user_id,actor_id,type,post_id,created_at) VALUES(?,?,?,?,?,?)", newId(), userId, actorId, type, postId, Date.now());
}
/** Sets the account's own AI declaration. An operator override takes precedence, so it can't be changed while one is set. */
export function setAiOperated(userId: string, value: boolean): void {
  const user = one<Pick<UserRow, "ai_operated_override">>("SELECT ai_operated_override FROM users WHERE id=?", userId);
  if (!user) throw new Error("User not found");
  if (user.ai_operated_override !== null) throw new Error("Elytra set this label on your account, so you can't change it");
  run("UPDATE users SET ai_operated=? WHERE id=?", value ? 1 : 0, userId);
}

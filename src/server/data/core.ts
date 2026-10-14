import "server-only";
import type { Viewer, UserSummary, NotificationType } from "@/lib/types";
import { getDb, transaction } from "../db";
import { hashPassword, newId, tokenHash, verifyPassword } from "../security";
import { randomBytes } from "node:crypto";

type Param = string | number | null;
export function all<T>(sql: string, ...params: Param[]): T[] { return getDb().prepare(sql).all(...params) as unknown as T[]; }
export function one<T>(sql: string, ...params: Param[]): T | undefined { return getDb().prepare(sql).get(...params) as unknown as T | undefined; }
export function run(sql: string, ...params: Param[]) { return getDb().prepare(sql).run(...params); }
export const placeholders = (items: unknown[]) => items.map(() => "?").join(",");
export type UserRow = {
  id: string; username: string; username_lower: string; display_name: string; password_hash: string;
  bio: string; location: string; website: string; avatar_url: string | null; banner_url: string | null; created_at: number; verified: number;
};
export function summary(user: UserRow): UserSummary { return { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, verified: !!user.verified }; }
export function viewerById(id: string): Viewer | null {
  const user = one<UserRow>("SELECT * FROM users WHERE id = ?", id);
  return user ? { ...summary(user), bio: user.bio } : null;
}
export const userByUsername = (username: string) => one<UserRow>("SELECT * FROM users WHERE username_lower = ?", username.toLowerCase());
export const RESERVED_USERNAMES = new Set(["home", "explore", "notifications", "bookmarks", "login", "signup", "api", "settings", "search", "compose", "messages", "welcome"]);
export function createUser(username: string, displayName: string, password: string): Viewer {
  if (!/^[A-Za-z0-9_]{3,15}$/.test(username)) throw new Error("Username must be 3–15 letters, numbers, or underscores");
  if (RESERVED_USERNAMES.has(username.toLowerCase())) throw new Error("That username isn't available");
  if (!displayName.trim() || [...displayName.trim()].length > 50) throw new Error("Display name must be 1–50 characters");
  if ([...password].length < 8) throw new Error("Password must be at least 8 characters");
  if ([...password].length > 1024) throw new Error("Password must be at most 1024 characters");
  const id = newId();
  run("INSERT INTO users(id,username,username_lower,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)", id, username, username.toLowerCase(), displayName.trim(), hashPassword(password), Date.now());
  return viewerById(id)!;
}
const dummyHash = hashPassword(randomBytes(24).toString("hex"));
export function authenticate(username: string, password: string): Viewer | null {
  const user = userByUsername(username);
  const valid = verifyPassword(password, user?.password_hash || dummyHash);
  return user && valid ? { ...summary(user), bio: user.bio } : null;
}
export const SESSION_AGE = 30 * 24 * 60 * 60;
export function createSession(userId: string): { token: string; expires: Date } {
  const token = randomBytes(32).toString("hex"), expires = new Date(Date.now() + SESSION_AGE * 1000);
  transaction(() => {
    run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    run("INSERT INTO sessions VALUES(?,?,?)", tokenHash(token), userId, expires.getTime());
  });
  return { token, expires };
}
export function viewerForToken(token: string): Viewer | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const user = one<UserRow>("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?", tokenHash(token), Date.now());
  return user ? { ...summary(user), bio: user.bio } : null;
}
export function deleteSession(token: string): void { run("DELETE FROM sessions WHERE token_hash=?", tokenHash(token)); }
export function notify(userId: string, actorId: string, type: NotificationType, postId: string | null): void {
  if (userId === actorId) return;
  if (one(`SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)`, userId, actorId, actorId, userId)) return;
  if (one("SELECT 1 FROM mutes WHERE user_id=? AND target_id=?", userId, actorId)) return;
  if (one("SELECT id FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND post_id IS ?", userId, actorId, type, postId)) return;
  run("INSERT INTO notifications(id,user_id,actor_id,type,post_id,created_at) VALUES(?,?,?,?,?,?)", newId(), userId, actorId, type, postId, Date.now());
}

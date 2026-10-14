import "server-only";
import type { Notification, NotificationType, Page, Post, UserListItem } from "../../lib/types";
import { all, one, run, summary, placeholders, type UserRow } from "./core";
import { listUsers, visibleNotificationSql } from "./people";
import { hydratePosts } from "./posts";
import { AppError } from "../errors";
import { decodeCursor, encodeCursor, type PageOptions } from "./pagination";

const visibleUserSql = `NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=u.id) OR (b.user_id=u.id AND b.target_id=?))`;
export function usersPage(viewerId: string | null, options: PageOptions, filter: { q?: string; userId?: string; direction?: "followers" | "following"; safety?: "block" | "mute" } = {}): Page<UserListItem> {
  const scope = JSON.stringify(["users", viewerId, filter]), key = decodeCursor(options.cursor, scope, ["string"]);
  let join = "", where = "1=1";
  const args: (string | number | null)[] = [];
  if (filter.direction) {
    const followers = filter.direction === "followers";
    join = `JOIN follows f ON u.id=f.${followers ? "follower_id" : "followee_id"}`;
    where = `f.${followers ? "followee_id" : "follower_id"}=?`; args.push(filter.userId!);
  } else if (filter.safety) {
    join = `JOIN ${filter.safety === "block" ? "blocks" : "mutes"} s ON s.target_id=u.id`;
    where = "s.user_id=?"; args.push(viewerId);
  } else if (filter.q !== undefined) {
    const q = filter.q.trim().replace(/^@/, "").toLowerCase();
    where = "(instr(u.username_lower,?)>0 OR instr(unicode_lower(u.display_name),?)>0)"; args.push(q, q);
  }
  if (!filter.safety) { where += ` AND ${visibleUserSql}`; args.push(viewerId, viewerId); }
  if (key) { where += " AND u.username_lower>?"; args.push(key[0]); }
  const rows = all<UserRow>(`SELECT u.* FROM users u ${join} WHERE ${where} ORDER BY u.username_lower LIMIT ?`, ...args, options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1);
  return { items: listUsers(selected, viewerId), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.username_lower]) : null };
}
export function notificationsPage(viewerId: string, options: PageOptions, mentionsOnly: boolean): Page<Notification> {
  const scope = `notifications:${viewerId}:${mentionsOnly}`, key = decodeCursor(options.cursor, scope, ["number", "string"]);
  type Row = { id: string; actor_id: string; type: NotificationType; post_id: string | null; created_at: number; read: number };
  const rows = all<Row>(`SELECT n.* FROM notifications n WHERE user_id=? AND ${visibleNotificationSql}
    ${mentionsOnly ? "AND type IN ('mention','reply')" : ""}
    ${key ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`, viewerId, ...(key ? [key[0], key[0], key[1]] : []), options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1), ids = [...new Set(selected.map(r => r.actor_id))];
  const actors = new Map(ids.length ? all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(ids)})`, ...ids).map(r => [r.id, summary(r)]) : []);
  const posts = hydratePosts(selected.flatMap(r => r.post_id ? [r.post_id] : []), viewerId);
  return { items: selected.map(r => ({ id: r.id, actor: actors.get(r.actor_id)!, type: r.type, post: r.post_id ? posts.get(r.post_id) ?? null : null, createdAt: new Date(r.created_at).toISOString(), read: !!r.read })), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.created_at, last.id]) : null };
}
export function markNotificationRead(viewerId: string, id: string): void {
  if (!one("SELECT 1 FROM notifications WHERE id=? AND user_id=?", id, viewerId)) throw new AppError(404, "not_found", "Notification not found");
  run("UPDATE notifications SET read=1 WHERE id=? AND user_id=?", id, viewerId);
}
export function relatedPostsPage(postId: string, viewerId: string | null, kind: "replies" | "quotes", options: PageOptions): Page<Post> {
  const scope = `${kind}:${viewerId}:${postId}`, key = decodeCursor(options.cursor, scope, ["number", "string"]);
  const rows = all<{ id: string; created_at: number }>(`SELECT p.id,p.created_at FROM posts p WHERE ${kind === "replies" ? "reply_to_id" : "quote_id"}=?
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=p.author_id) OR (b.user_id=p.author_id AND b.target_id=?))
    ${key ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`, postId, viewerId, viewerId, ...(key ? [key[0], key[0], key[1]] : []), options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1), posts = hydratePosts(selected.map(r => r.id), viewerId);
  return { items: selected.flatMap(r => posts.has(r.id) ? [posts.get(r.id)!] : []), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.created_at, last.id]) : null };
}
export function postUsersPage(postId: string, viewerId: string | null, kind: "likes" | "reposts", options: PageOptions): Page<UserListItem> {
  const scope = `${kind}:${viewerId}:${postId}`, key = decodeCursor(options.cursor, scope, ["string"]);
  const rows = all<UserRow>(`SELECT u.* FROM users u JOIN ${kind} i ON i.user_id=u.id WHERE i.post_id=? AND ${visibleUserSql}
    ${key ? "AND u.username_lower>?" : ""} ORDER BY u.username_lower LIMIT ?`, postId, viewerId, viewerId, ...(key ? [key[0]] : []), options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1);
  return { items: listUsers(selected, viewerId), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.username_lower]) : null };
}

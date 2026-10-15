import "server-only";
import type { Profile, UserListItem, Notification, NotificationType, Trend } from "@/lib/types";
import { all, one, run, summary, userByUsername, notify, placeholders } from "./core";
import type { UserRow } from "./core";
import { transaction } from "../db";
import { hydratePosts } from "./posts";
import { assertCanInteract, blockedIds } from "./safety";
import { claimUpload } from "./uploads";

export function listUsers(rows: UserRow[], viewerId: string | null): UserListItem[] {
  const ids = rows.map(u => u.id);
  if (!ids.length) return [];
  const following = new Set(all<{ followee_id: string }>(`SELECT followee_id FROM follows WHERE follower_id=? AND followee_id IN (${placeholders(ids)})`, viewerId, ...ids).map(r => r.followee_id));
  const followers = new Set(all<{ follower_id: string }>(`SELECT follower_id FROM follows WHERE followee_id=? AND follower_id IN (${placeholders(ids)})`, viewerId, ...ids).map(r => r.follower_id));
  return rows.map(u => ({ ...summary(u), bio: u.bio, isFollowing: following.has(u.id), followsYou: followers.has(u.id), isSelf: u.id === viewerId }));
}
export function profileByUsername(username: string, viewerId: string | null): Profile | null {
  const user = userByUsername(username);
  if (!user) return null;
  const flags = listUsers([user], viewerId)[0];
  const counts = one<{ followers: number; following: number; posts: number }>(`SELECT
    (SELECT COUNT(*) FROM follows WHERE followee_id=?) AS followers,
    (SELECT COUNT(*) FROM follows WHERE follower_id=?) AS following,
    (SELECT COUNT(*) FROM posts WHERE author_id=?) AS posts`, user.id, user.id, user.id)!;
  return { ...flags, location: user.location, website: user.website, bannerUrl: user.banner_url, createdAt: new Date(user.created_at).toISOString(), aiOperatedLocked: user.ai_operated_override !== null, followersCount: counts.followers, followingCount: counts.following, postsCount: counts.posts };
}
export function followersOf(username: string, viewerId: string | null, direction: "followers" | "following"): UserListItem[] {
  const user = userByUsername(username);
  if (!user) return [];
  const followers = direction === "followers";
  return listUsers(all<UserRow>(`SELECT u.* FROM users u JOIN follows f ON u.id=f.${followers ? "follower_id" : "followee_id"} WHERE f.${followers ? "followee_id" : "follower_id"}=? ORDER BY f.created_at DESC,u.id LIMIT 100`, user.id), viewerId);
}
export function findUsers(q: string, limit: number, viewerId: string | null): UserListItem[] {
  const needle = q.trim().replace(/^@/, "").toLowerCase();
  const blocked = blockedIds(viewerId);
  return listUsers(all<UserRow>(`SELECT * FROM users WHERE instr(username_lower,?)>0 OR instr(unicode_lower(display_name),?)>0 ORDER BY (username_lower=?) DESC,username_lower LIMIT ?`, needle, needle, needle, Math.max(0, Math.min(100, Math.floor(limit) || 0))).filter(u => !blocked.has(u.id)), viewerId);
}
export function suggestedUsers(limit: number, viewerId: string | null): UserListItem[] {
  const blocked = blockedIds(viewerId);
  return listUsers(all<UserRow>(`SELECT u.* FROM users u WHERE (? IS NULL OR u.id<>?) AND NOT EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.followee_id=u.id) ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.followee_id=u.id) DESC,u.username_lower LIMIT ?`, viewerId, viewerId, viewerId, Math.max(0, Math.min(100, Math.floor(limit) || 0))).filter(u => !blocked.has(u.id)), viewerId);
}
export function toggleFollowUser(viewerId: string, userId: string, desired?: boolean): boolean {
  if (viewerId === userId) throw new Error("You cannot follow yourself");
  return transaction(() => {
    if (!one("SELECT id FROM users WHERE id=?", userId)) throw new Error("User not found");
    const exists = !!one("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", viewerId, userId);
    const active = desired ?? !exists;
    if (active) assertCanInteract(viewerId, userId);
    if (exists && !active) {
      run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", viewerId, userId);
      run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='follow'", userId, viewerId);
      return false;
    }
    if (!exists && active) {
      run("INSERT INTO follows VALUES(?,?,?)", viewerId, userId, Date.now());
      notify(userId, viewerId, "follow", null);
    }
    return active;
  });
}
export type ProfileUpdate = { displayName: string; bio: string; location: string; website: string; avatarUrl?: string | null; bannerUrl?: string | null; avatarMediaId?: string; bannerMediaId?: string };
export function editProfile(viewerId: string, update: ProfileUpdate): string[] {
  return transaction(() => {
    const user = one<UserRow>("SELECT * FROM users WHERE id=?", viewerId);
    if (!user) throw new Error("User not found");
    const avatar = update.avatarMediaId ? claimUpload(viewerId, update.avatarMediaId, "avatar") : update.avatarUrl === undefined ? user.avatar_url : update.avatarUrl;
    const banner = update.bannerMediaId ? claimUpload(viewerId, update.bannerMediaId, "banner") : update.bannerUrl === undefined ? user.banner_url : update.bannerUrl;
    run("UPDATE users SET display_name=?,bio=?,location=?,website=?,avatar_url=?,banner_url=? WHERE id=?", update.displayName, update.bio, update.location, update.website, avatar, banner, viewerId);
    return [user.avatar_url !== avatar ? user.avatar_url : null, user.banner_url !== banner ? user.banner_url : null].filter((url): url is string => !!url);
  });
}
export function trends(limit: number): Trend[] {
  const since = Date.now() - 7 * 86400000;
  return all<{ tag: string; postCount: number }>(`SELECT h.tag,COUNT(DISTINCT p.id) AS postCount
    FROM hashtags h JOIN posts p ON p.id=h.post_id
    WHERE p.created_at>=?
    GROUP BY h.tag
    ORDER BY postCount DESC,MAX(p.created_at) DESC,h.tag
    LIMIT ?`, since, Math.max(0, Math.min(100, Math.floor(limit) || 0)));
}
export function notificationsFor(viewerId: string | null, mentionsOnly = false): Notification[] {
  if (!viewerId) return [];
  type Row = { id: string; actor_id: string; type: NotificationType; post_id: string | null; created_at: number; read: number };
  const rows = all<Row>(`SELECT * FROM notifications n WHERE user_id=? AND ${visibleNotificationSql} ${mentionsOnly ? "AND type IN ('mention','reply')" : ""} ORDER BY created_at DESC,id DESC LIMIT 50`, viewerId);
  if (!rows.length) return [];
  const actorIds = [...new Set(rows.map(r => r.actor_id))];
  const actors = new Map(all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(actorIds)})`, ...actorIds).map(u => [u.id, summary(u)]));
  const posts = hydratePosts(rows.flatMap(r => r.post_id ? [r.post_id] : []), viewerId);
  return rows.map(r => ({ id: r.id, type: r.type, actor: actors.get(r.actor_id)!, post: r.post_id ? posts.get(r.post_id) || null : null, createdAt: new Date(r.created_at).toISOString(), read: !!r.read }));
}
export const visibleNotificationSql = `NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=n.user_id AND b.target_id=n.actor_id) OR (b.user_id=n.actor_id AND b.target_id=n.user_id)) AND NOT EXISTS(SELECT 1 FROM mutes m WHERE m.user_id=n.user_id AND m.target_id=n.actor_id)`;
export const unreadCount = (viewerId: string | null): number => viewerId ? one<{ count: number }>(`SELECT COUNT(*) AS count FROM notifications n WHERE user_id=? AND read=0 AND ${visibleNotificationSql}`, viewerId)!.count : 0;
export function readNotifications(viewerId: string): void { run("UPDATE notifications SET read=1 WHERE user_id=? AND read=0", viewerId); }

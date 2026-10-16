import "server-only";
import type { FeedItem, Page, TimelineSource } from "@/lib/types";
import { all, one, run, summary, userByUsername, placeholders } from "./core";
import type { UserRow } from "./core";
import { hydratePosts } from "./posts";
import { newId } from "../security";
import { backendConfig } from "../config";
import { maintainDatabase } from "../db-maintenance";
import { getDb, transaction } from "../db";
import { recommendedEntries } from "./recommendations";
import { blockedIds, mutedIds } from "./safety";
import { AppError } from "../errors";
import { heldPostFilter } from "../moderation/policy";
import { discoveryFilter } from "../moderation/worker";

type Entry = { key: string; postId: string; reposterId: string | null };
const empty = (): Page<FeedItem> => ({ items: [], nextCursor: null });
const SNAPSHOT_AGE = 86400000;
/** Other profiles expose only the five most recent likes; the owner and paginated history are not public. */
const LIKES_PUBLIC_LIMIT = 5;
export function validTimelineSource(value: unknown): value is TimelineSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.kind === "bookmarks") return true;
  if (s.kind === "home") return s.tab === "for-you" || s.tab === "following";
  if (s.kind === "user") return typeof s.username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(s.username) && typeof s.tab === "string" && ["posts", "replies", "media", "likes"].includes(s.tab);
  if (s.kind === "search") return typeof s.q === "string" && s.q.length <= 500 && typeof s.tab === "string" && ["top", "latest", "media"].includes(s.tab);
  return false;
}
function sourceKey(source: TimelineSource): string {
  switch (source.kind) {
    case "home": return JSON.stringify([source.kind, source.tab]);
    case "user": return JSON.stringify([source.kind, source.username.toLowerCase(), source.tab]);
    case "search": return JSON.stringify([source.kind, source.q.trim().toLowerCase(), source.tab]);
    case "bookmarks": return "bookmarks";
  }
}
function candidates(source: TimelineSource, viewerId: string | null): Entry[] {
  if (source.kind === "home" && source.tab === "for-you") return recommendedEntries(viewerId).slice(0, backendConfig().snapshotEntries);
  type Candidate = Entry & { time: number; score: number };
  let sql = "", args: (string | number | null)[] = [];
  // Likes are the only tab with a public-history cap: anonymous or unrelated viewers get the
  // five most recent, the owner browses everything, and no cursor can expose the rest.
  const cap = source.kind === "user" && source.tab === "likes" && viewerId !== userByUsername(source.username)?.id
    ? Math.min(LIKES_PUBLIC_LIMIT, backendConfig().snapshotEntries) : backendConfig().snapshotEntries;
  const postSelect = "SELECT 'post:' || p.id AS key,p.id AS postId,NULL AS reposterId,p.created_at AS time,0 AS score FROM posts p";
  const repostSelect = "SELECT 'repost:' || r.user_id || ':' || p.id AS key,p.id AS postId,r.user_id AS reposterId,r.created_at AS time,0 AS score FROM reposts r JOIN posts p ON p.id=r.post_id";
  if (source.kind === "home") {
    if (source.tab === "following") {
      if (!viewerId) return [];
      sql = `${postSelect} WHERE p.reply_to_id IS NULL AND p.author_id IN (SELECT followee_id FROM follows WHERE follower_id=?) UNION ALL ${repostSelect} WHERE r.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)`;
      args = [viewerId, viewerId];
    } else sql = `${postSelect} WHERE p.reply_to_id IS NULL UNION ALL ${repostSelect}`;
  } else if (source.kind === "user") {
    const user = userByUsername(source.username);
    if (!user) return [];
    if (source.tab === "likes") {
      sql = "SELECT 'like:' || l.user_id || ':' || p.id AS key,p.id AS postId,NULL AS reposterId,l.created_at AS time,0 AS score FROM likes l JOIN posts p ON p.id=l.post_id WHERE l.user_id=?";
      args = [user.id];
    } else if (source.tab === "posts") {
      sql = `${postSelect} WHERE p.author_id=? AND p.reply_to_id IS NULL UNION ALL ${repostSelect} WHERE r.user_id=?`;
      args = [user.id, user.id];
    } else {
      sql = `${postSelect} WHERE p.author_id=? ${source.tab === "media" ? "AND EXISTS(SELECT 1 FROM post_images i WHERE i.post_id=p.id)" : ""}`;
      args = [user.id];
    }
  } else if (source.kind === "bookmarks") {
    if (!viewerId) return [];
    sql = "SELECT 'bookmark:' || p.id AS key,p.id AS postId,NULL AS reposterId,b.created_at AS time,0 AS score FROM bookmarks b JOIN posts p ON p.id=b.post_id WHERE b.user_id=?";
    args = [viewerId];
  } else {
    const q = source.q.trim().toLowerCase();
    if (!q) return [];
    let filter = "instr(unicode_lower(p.content),?)>0";
    args = [q];
    if (q.startsWith("#")) { filter = "EXISTS(SELECT 1 FROM hashtags h WHERE h.post_id=p.id AND h.tag=?)"; args = [q.slice(1)]; }
    if (q.startsWith("@")) { filter = "EXISTS(SELECT 1 FROM mentions m JOIN users u ON u.id=m.user_id WHERE m.post_id=p.id AND u.username_lower=?)"; args = [q.slice(1)]; }
    filter += ` AND ${discoveryFilter()}`;
    if (source.tab === "media") filter += " AND EXISTS(SELECT 1 FROM post_images i WHERE i.post_id=p.id)";
    if (source.tab === "top") {
      const since = Date.now() - 30 * 86400000;
      if (one(`SELECT 1 FROM posts p WHERE ${filter} AND p.created_at>=? LIMIT 1`, ...args, since)) { filter += " AND p.created_at>=?"; args.push(since); }
    }
    sql = `SELECT 'post:' || p.id AS key,p.id AS postId,NULL AS reposterId,p.created_at AS time,
      ${source.tab === "top" ? "(SELECT likes+2*reposts+replies FROM post_stats s WHERE s.post_id=p.id)" : "0"} AS score FROM posts p WHERE ${filter}`;
  }
  return all<Candidate>(`SELECT * FROM (${sql}) ORDER BY ${source.kind === "search" && source.tab === "top" ? "score DESC," : ""}time DESC,key DESC LIMIT ?`, ...args, cap).map(({ key, postId, reposterId }) => ({ key, postId, reposterId }));
}
/** A snapshot (up to 24 hours, subject to the per-viewer retention budget) freezes event order, including search popularity, across load-more calls. */
export function timeline(source: TimelineSource, cursor: string | null | undefined, viewerId: string | null, options: { limit?: number; strictCursor?: boolean } = {}): Page<FeedItem> {
  if (!validTimelineSource(source)) return empty();
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const badCursor = () => { if (options.strictCursor) throw new AppError(400, "invalid_cursor", "Cursor is invalid, expired, or belongs to another feed or account"); return empty(); };
  if (!cursor) maintainDatabase(getDb());
  {
    const sourceId = sourceKey(source);
    let entries: Entry[], snapshotId: string, offset = 0;
    if (cursor) {
      if (typeof cursor !== "string" || cursor.length > 500) return badCursor();
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || !Number.isSafeInteger(decoded[1]) || decoded[1] < 0) return badCursor();
        [snapshotId, offset] = decoded as [string, number];
      } catch { return badCursor(); }
      const snapshot = one<{ entries: string }>("SELECT entries FROM timeline_snapshots WHERE id=? AND viewer_id IS ? AND source=? AND created_at>?", snapshotId, viewerId, sourceId, Date.now() - SNAPSHOT_AGE);
      if (!snapshot) return badCursor();
      entries = JSON.parse(snapshot.entries) as Entry[];
      if (offset > entries.length) return badCursor();
    } else {
      entries = candidates(source, viewerId);
      if (!entries.length) return empty();
      const encoded = JSON.stringify(entries);
      const previous = one<{ id: string; entries: string }>("SELECT id,entries FROM timeline_snapshots WHERE viewer_id IS ? AND source=? AND created_at>? ORDER BY created_at DESC LIMIT 1", viewerId, sourceId, Date.now() - SNAPSHOT_AGE);
      if (previous?.entries === encoded) snapshotId = previous.id;
      else {
        snapshotId = newId();
        transaction(() => {
          run("INSERT INTO timeline_snapshots VALUES(?,?,?,?,?)", snapshotId, viewerId, sourceId, encoded, Date.now());
          // Bound retained storage even when a client opens fresh feeds repeatedly.
          run(`DELETE FROM timeline_snapshots WHERE id IN (SELECT id FROM timeline_snapshots
            WHERE viewer_id IS ? AND id<>? ORDER BY created_at DESC,id DESC LIMIT 500 OFFSET ?)`, viewerId, snapshotId, backendConfig().snapshotsPerViewer - 1);
        });
      }
    }
    // Deleted posts or undone reposts/likes/bookmarks are skipped without shifting the snapshot positions.
    const selected: Entry[] = [];
    const hiddenUsers = blockedIds(viewerId);
    if (source.kind === "home" || source.kind === "search") for (const id of mutedIds(viewerId)) hiddenUsers.add(id);
    // Follow changes apply to existing snapshots as well as newly opened feeds.
    const followed = source.kind === "home" && source.tab === "following"
      ? new Set(all<{ followee_id: string }>("SELECT followee_id FROM follows WHERE follower_id=?", viewerId).map(r => r.followee_id))
      : null;
    let position = offset;
    while (position < entries.length && selected.length < limit + 1) {
      const batch = entries.slice(position, position + 100), ids = [...new Set(batch.map(e => e.postId))];
      const discovery = source.kind === "search" || (source.kind === "home" && source.tab === "for-you");
      const present = new Map(all<{ id: string; author_id: string }>(`SELECT p.id,p.author_id FROM posts p WHERE p.id IN (${placeholders(ids)}) AND ${heldPostFilter()} AND ${discovery ? discoveryFilter() : "1=1"}`, ...ids).filter(r => !hiddenUsers.has(r.author_id)).map(r => [r.id, r.author_id]));
      const reposts = new Set(all<{ key: string }>(`SELECT user_id || ':' || post_id AS key FROM reposts WHERE post_id IN (${placeholders(ids)})`, ...ids).map(r => r.key));
      const liked = source.kind === "user" && source.tab === "likes" ? new Set(all<{ post_id: string }>(`SELECT l.post_id FROM likes l JOIN users u ON u.id=l.user_id WHERE u.username_lower=? AND l.post_id IN (${placeholders(ids)})`, source.username.toLowerCase(), ...ids).map(r => r.post_id)) : null;
      const saved = source.kind === "bookmarks" ? new Set(all<{ post_id: string }>(`SELECT post_id FROM bookmarks WHERE user_id=? AND post_id IN (${placeholders(ids)})`, viewerId, ...ids).map(r => r.post_id)) : null;
      // Explicit dismissals take effect immediately; impressions only affect new snapshots.
      const hidden = source.kind === "home" && source.tab === "for-you" ? new Set(all<{ post_id: string }>(`SELECT post_id FROM negative_feedback WHERE user_id=? AND post_id IN (${placeholders(ids)})`, viewerId, ...ids).map(r => r.post_id)) : null;
      for (const entry of batch) {
        const inNetwork = !followed || followed.has(entry.reposterId ?? present.get(entry.postId)!);
        if (inNetwork && present.has(entry.postId) && (!entry.reposterId || (!hiddenUsers.has(entry.reposterId) && reposts.has(`${entry.reposterId}:${entry.postId}`))) && (!liked || liked.has(entry.postId)) && (!saved || saved.has(entry.postId)) && !hidden?.has(entry.postId)) {
          if (selected.length === limit) { selected.push(entry); break; }
          selected.push(entry);
        }
        position++;
      }
    }
    const hasMore = selected.length > limit;
    const pageEntries = selected.slice(0, limit);
    const posts = hydratePosts(pageEntries.map(e => e.postId), viewerId);
    const reposterIds = [...new Set(pageEntries.flatMap(e => e.reposterId ? [e.reposterId] : []))];
    const reposters = new Map(reposterIds.length ? all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(reposterIds)})`, ...reposterIds).map(u => [u.id, summary(u)]) : []);
    return { items: pageEntries.map(e => ({ key: e.key, post: posts.get(e.postId)!, repostedBy: e.reposterId ? reposters.get(e.reposterId) || null : null })), nextCursor: hasMore ? Buffer.from(JSON.stringify([snapshotId, position])).toString("base64url") : null };
  }
}

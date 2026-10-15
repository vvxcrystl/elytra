import "server-only";
import { all, one, placeholders, run } from "./core";
import { transaction } from "../db";
import { AppError } from "../errors";

export function validPostId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

const REPEAT_MS = 60000;
/** Batches are atomic; removed posts are harmless when a visibility callback arrives late.
 * A post's view count goes up with each counted impression, except the author's own. */
export function saveImpressions(viewerId: string, postIds: string[], now = Date.now()): void {
  if (!Array.isArray(postIds) || postIds.length > 100 || postIds.some(id => !validPostId(id))) throw new Error("Invalid post IDs (at most 100)");
  const ids = [...new Set(postIds)];
  if (!ids.length) return;
  transaction(() => {
    const present = all<{ id: string; author_id: string }>(`SELECT id,author_id FROM posts WHERE id IN (${placeholders(ids)})`, ...ids);
    for (const { id, author_id } of present) {
      const seen = one<{ last_seen_at: number }>("SELECT last_seen_at FROM impressions WHERE user_id=? AND post_id=?", viewerId, id);
      run(`INSERT INTO impressions VALUES(?,?,?,?,1)
        ON CONFLICT(user_id,post_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
        seen_count=impressions.seen_count+CASE WHEN excluded.last_seen_at-impressions.last_seen_at>=${REPEAT_MS} THEN 1 ELSE 0 END`, viewerId, id, now, now);
      if (author_id !== viewerId && (!seen || now - seen.last_seen_at >= REPEAT_MS)) run("UPDATE post_stats SET views=views+1 WHERE post_id=?", id);
    }
  });
}

const VISIT_COLUMNS = { detail: "detail_expands", profile: "profile_visits" } as const;
export type PostVisitKind = keyof typeof VISIT_COLUMNS;
export const validVisitKind = (value: unknown): value is PostVisitKind => typeof value === "string" && Object.hasOwn(VISIT_COLUMNS, value);
/**
 * Records that a viewer opened a post (`detail`) or went from it to its author's profile (`profile`).
 * The author's own visits and repeats within a minute don't count. Opening a post also counts as seeing it.
 */
export function savePostVisit(viewerId: string, postId: string, kind: PostVisitKind, now = Date.now()): void {
  if (!validPostId(postId) || !validVisitKind(kind)) throw new Error("Invalid post visit");
  transaction(() => {
    const post = one<{ author_id: string }>("SELECT author_id FROM posts WHERE id=?", postId);
    if (!post) return;
    if (kind === "detail") saveImpressions(viewerId, [postId], now);
    if (post.author_id === viewerId) return;
    const visit = one<{ last_at: number }>("SELECT last_at FROM post_visits WHERE user_id=? AND post_id=? AND kind=?", viewerId, postId, kind);
    run(`INSERT INTO post_visits VALUES(?,?,?,?,1) ON CONFLICT(post_id,user_id,kind) DO UPDATE SET last_at=excluded.last_at,
      count=post_visits.count+CASE WHEN excluded.last_at-post_visits.last_at>=${REPEAT_MS} THEN 1 ELSE 0 END`, viewerId, postId, kind, now);
    if (!visit || now - visit.last_at >= REPEAT_MS) run(`UPDATE post_stats SET ${VISIT_COLUMNS[kind]}=${VISIT_COLUMNS[kind]}+1 WHERE post_id=?`, postId);
  });
}

export type PostAnalytics = {
  impressions: number; engagements: number; detailExpands: number; profileVisits: number;
  replies: number; reposts: number; likes: number; bookmarks: number;
};
/** Only the author can read these. Engagements add every counted reaction and visit. */
export function postAnalytics(viewerId: string, postId: string): PostAnalytics {
  const row = one<{ author_id: string; views: number; detail_expands: number; profile_visits: number; replies: number; reposts: number; likes: number; bookmarks: number }>(
    "SELECT p.author_id,s.views,s.detail_expands,s.profile_visits,s.replies,s.reposts,s.likes,s.bookmarks FROM posts p JOIN post_stats s ON s.post_id=p.id WHERE p.id=?", postId);
  if (!row) throw new AppError(404, "not_found", "Post not found");
  if (row.author_id !== viewerId) throw new AppError(403, "forbidden", "Only the author can see a post's analytics");
  return {
    impressions: row.views, detailExpands: row.detail_expands, profileVisits: row.profile_visits,
    replies: row.replies, reposts: row.reposts, likes: row.likes, bookmarks: row.bookmarks,
    engagements: row.replies + row.reposts + row.likes + row.bookmarks + row.detail_expands + row.profile_visits,
  };
}

export function saveNotInterested(viewerId: string, postId: string, now = Date.now()): void {
  if (!validPostId(postId)) throw new Error("Invalid post ID");
  transaction(() => {
    const post = one<{ author_id: string }>("SELECT author_id FROM posts WHERE id=?", postId);
    if (!post) throw new Error("This post no longer exists");
    run(`INSERT INTO negative_feedback VALUES(?,?,?,?) ON CONFLICT(user_id,post_id)
      DO UPDATE SET created_at=excluded.created_at`, viewerId, postId, post.author_id, now);
  });
}

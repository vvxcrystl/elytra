import "server-only";
import { all, one, placeholders, run } from "./core";
import { transaction } from "../db";

export function validPostId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

/** Batches are atomic; removed posts are harmless when a visibility callback arrives late. */
export function saveImpressions(viewerId: string, postIds: string[], now = Date.now()): void {
  if (!Array.isArray(postIds) || postIds.length > 100 || postIds.some(id => !validPostId(id))) throw new Error("Invalid post IDs (at most 100)");
  const ids = [...new Set(postIds)];
  if (!ids.length) return;
  transaction(() => {
    const present = all<{ id: string }>(`SELECT id FROM posts WHERE id IN (${placeholders(ids)})`, ...ids);
    for (const { id } of present) run(`INSERT INTO impressions VALUES(?,?,?,?,1)
      ON CONFLICT(user_id,post_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
      seen_count=impressions.seen_count+CASE WHEN excluded.last_seen_at-impressions.last_seen_at>=60000 THEN 1 ELSE 0 END`, viewerId, id, now, now);
  });
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

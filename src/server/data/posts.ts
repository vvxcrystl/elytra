import "server-only";
import type { Post, QuotedPost, PostThread } from "@/lib/types";
import { POST_MAX_IMAGES, POST_MAX_LENGTH } from "../../lib/types";
import { all, one, run, placeholders, summary, notify } from "./core";
import type { UserRow } from "./core";
import { transaction } from "../db";
import { newId } from "../security";
import { assertCanInteract, blockedIds } from "./safety";
import { claimUpload } from "./uploads";

type PostRow = { id: string; author_id: string; content: string; reply_to_id: string | null; quote_id: string | null; created_at: number };
export function hydratePosts(ids: string[], viewerId: string | null): Map<string, Post> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const blocked = blockedIds(viewerId);
  const posts = all<PostRow>(`SELECT * FROM posts WHERE id IN (${placeholders(unique)})`, ...unique).filter(p => !blocked.has(p.author_id));
  const related = [...new Set(posts.flatMap(p => [p.quote_id, p.reply_to_id].filter((id): id is string => !!id)))];
  const extra = related.length ? all<PostRow>(`SELECT * FROM posts WHERE id IN (${placeholders(related)})`, ...related).filter(p => !blocked.has(p.author_id)) : [];
  const rowMap = new Map([...posts, ...extra].map(p => [p.id, p]));
  const allRows = [...rowMap.values()], postIds = [...rowMap.keys()];
  const authorIds = [...new Set(allRows.map(p => p.author_id))];
  const authors = new Map(authorIds.length ? all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(authorIds)})`, ...authorIds).map(u => [u.id, summary(u)]) : []);
  const images = new Map<string, string[]>();
  if (postIds.length) for (const image of all<{ post_id: string; url: string }>(`SELECT * FROM post_images WHERE post_id IN (${placeholders(postIds)}) ORDER BY position`, ...postIds)) {
    images.set(image.post_id, [...(images.get(image.post_id) || []), image.url]);
  }
  const stats = new Map(all<{ post_id: string; likes: number; reposts: number; bookmarks: number; replies: number; views: number }>(`SELECT * FROM post_stats WHERE post_id IN (${placeholders(unique)})`, ...unique).map(r => [r.post_id, r]));
  const mine = (table: "likes" | "reposts" | "bookmarks") => new Set(all<{ post_id: string }>(`SELECT post_id FROM ${table} WHERE user_id=? AND post_id IN (${placeholders(unique)})`, viewerId, ...unique).map(r => r.post_id));
  const likes = mine("likes"), reposts = mine("reposts"), bookmarks = mine("bookmarks");
  return new Map(posts.map(p => {
    let quote: QuotedPost | null = null;
    if (p.quote_id) {
      const q = rowMap.get(p.quote_id);
      quote = q ? { id: q.id, author: authors.get(q.author_id)!, content: q.content, createdAt: new Date(q.created_at).toISOString(), imageUrls: images.get(q.id) || [], deleted: false }
        : { id: p.quote_id, author: { id: "", username: "", displayName: "Deleted post", avatarUrl: null, verified: false, aiOperated: false }, content: "", createdAt: new Date(0).toISOString(), imageUrls: [], deleted: true };
    }
    const parent = p.reply_to_id ? rowMap.get(p.reply_to_id) : null;
    const post: Post = { id: p.id, author: authors.get(p.author_id)!, content: p.content, createdAt: new Date(p.created_at).toISOString(), imageUrls: images.get(p.id) || [], replyToId: p.reply_to_id, replyToUsername: parent ? authors.get(parent.author_id)?.username || null : null, quote, likeCount: stats.get(p.id)?.likes || 0, repostCount: stats.get(p.id)?.reposts || 0, bookmarkCount: stats.get(p.id)?.bookmarks || 0, replyCount: stats.get(p.id)?.replies || 0, viewCount: p.author_id === viewerId ? stats.get(p.id)?.views || 0 : null, viewer: { liked: likes.has(p.id), reposted: reposts.has(p.id), bookmarked: bookmarks.has(p.id) } };
    return [p.id, post];
  }));
}
export const postById = (id: string, viewerId: string | null) => hydratePosts([id], viewerId).get(id) || null;
export function postThread(id: string, viewerId: string | null): PostThread | null {
  const target = one<PostRow>("SELECT * FROM posts WHERE id=?", id);
  if (!target || blockedIds(viewerId).has(target.author_id)) return null;
  // The recursive query stops at deleted parents and guards against corrupt cycles.
  const ancestors = all<{ id: string; depth: number }>(`WITH RECURSIVE chain(id,reply_to_id,depth,path) AS (
    SELECT id,reply_to_id,0,',' || id || ',' FROM posts WHERE id=?
    UNION ALL SELECT p.id,p.reply_to_id,c.depth+1,c.path || p.id || ',' FROM posts p JOIN chain c ON p.id=c.reply_to_id
    WHERE instr(c.path,',' || p.id || ',')=0 AND c.depth<100
  ) SELECT id,depth FROM chain WHERE depth>0 ORDER BY depth DESC`, id);
  const replies = all<{ id: string }>(`SELECT p.id FROM posts p WHERE reply_to_id=? ORDER BY (author_id=?) DESC,
    (SELECT likes FROM post_stats s WHERE s.post_id=p.id) DESC, created_at ASC, id ASC LIMIT 100`, id, target.author_id);
  const hydrated = hydratePosts([id, ...ancestors.map(p => p.id), ...replies.map(p => p.id)], viewerId);
  const visible = (rows: { id: string }[]) => rows.flatMap(p => hydrated.has(p.id) ? [hydrated.get(p.id)!] : []);
  return { post: hydrated.get(id)!, ancestors: visible(ancestors), replies: visible(replies) };
}
export type NewPost = { content: string; replyToId?: string | null; quoteId?: string | null; imageUrls?: string[]; mediaIds?: string[] };
export function insertPost(viewerId: string, input: NewPost): string {
  const content = input.content.trim(), imageUrls = input.imageUrls || [];
  if ([...content].length > POST_MAX_LENGTH) throw new Error(`Posts can be at most ${POST_MAX_LENGTH} characters`);
  if (!content && !imageUrls.length && !input.mediaIds?.length && !input.quoteId) throw new Error("Write something or add an image");
  if ((input.mediaIds?.length ?? 0) + imageUrls.length > POST_MAX_IMAGES || new Set(input.mediaIds).size !== (input.mediaIds?.length ?? 0)) throw new Error("Invalid images");
  if (imageUrls.length > POST_MAX_IMAGES || imageUrls.some(url => !/^\/api\/media\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(url))) throw new Error("Invalid images");
  return transaction(() => {
    const urls = [...imageUrls, ...(input.mediaIds ?? []).map(id => claimUpload(viewerId, id, "post"))];
    const reply = input.replyToId ? one<PostRow>("SELECT * FROM posts WHERE id=?", input.replyToId) : null;
    const quote = input.quoteId ? one<PostRow>("SELECT * FROM posts WHERE id=?", input.quoteId) : null;
    if (input.replyToId && !reply) throw new Error("The post you are replying to no longer exists");
    if (input.quoteId && !quote) throw new Error("The quoted post no longer exists");
    if (reply) assertCanInteract(viewerId, reply.author_id);
    if (quote) assertCanInteract(viewerId, quote.author_id);
    const id = newId();
    run("INSERT INTO posts(id,author_id,content,reply_to_id,quote_id,created_at) VALUES(?,?,?,?,?,?)", id, viewerId, content, input.replyToId || null, input.quoteId || null, Date.now());
    urls.forEach((url, i) => run("INSERT INTO post_images VALUES(?,?,?)", id, url, i));
    for (const tag of new Set(Array.from(content.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu), m => m[1].toLowerCase()))) run("INSERT INTO hashtags VALUES(?,?)", id, tag);
    const recipients = new Map<string, "reply" | "quote" | "mention">();
    for (const name of new Set(Array.from(content.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g), m => m[1].toLowerCase()))) {
      const user = one<{ id: string }>("SELECT id FROM users WHERE username_lower=?", name);
      if (user) { run("INSERT OR IGNORE INTO mentions VALUES(?,?)", id, user.id); recipients.set(user.id, "mention"); }
    }
    if (quote) recipients.set(quote.author_id, "quote");
    if (reply) recipients.set(reply.author_id, "reply");
    for (const [userId, type] of recipients) notify(userId, viewerId, type, id);
    return id;
  });
}
export function removePost(viewerId: string, id: string): string[] {
  return transaction(() => {
    const post = one<PostRow>("SELECT * FROM posts WHERE id=?", id);
    if (!post) throw new Error("Post not found");
    if (post.author_id !== viewerId) throw new Error("You can only delete your own posts");
    const urls = all<{ url: string }>("SELECT url FROM post_images WHERE post_id=?", id).map(i => i.url);
    // Parent and quote IDs deliberately have no FK: replies survive and quotes become tombstones.
    run("DELETE FROM posts WHERE id=?", id);
    return urls;
  });
}
export function togglePostInteraction(viewerId: string, postId: string, kind: "like" | "repost" | "bookmark", desired?: boolean): { active: boolean; count: number } {
  return transaction(() => {
    const post = one<PostRow>("SELECT * FROM posts WHERE id=?", postId);
    if (!post) throw new Error("Post not found");
    const table = { like: "likes", repost: "reposts", bookmark: "bookmarks" }[kind];
    const exists = !!one(`SELECT 1 FROM ${table} WHERE user_id=? AND post_id=?`, viewerId, postId);
    const active = desired ?? !exists;
    if (active) assertCanInteract(viewerId, post.author_id);
    if (exists && !active) {
      run(`DELETE FROM ${table} WHERE user_id=? AND post_id=?`, viewerId, postId);
      if (kind !== "bookmark") run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND post_id=?", post.author_id, viewerId, kind, postId);
    } else if (!exists && active) {
      run(`INSERT INTO ${table} VALUES(?,?,?)`, viewerId, postId, Date.now());
      if (kind !== "bookmark") notify(post.author_id, viewerId, kind, postId);
    }
    return { active, count: one<{ count: number }>(`SELECT ${table} AS count FROM post_stats WHERE post_id=?`, postId)!.count };
  });
}

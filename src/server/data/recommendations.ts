import "server-only";
import { all, placeholders } from "./core";
import { backendConfig } from "../config";
import { discoveryFilter } from "../moderation/worker";

const DAY = 86400000;
const POOL = 150;
const STRONG_SIMILARITY = 0.6;
export type RecommendationEntry = { key: string; postId: string; reposterId: string | null };
type Candidate = {
  id: string; author_id: string; created_at: number; reply_to_id: string | null;
  reposterId: string | null; inNetwork: boolean; similarity: number;
};
type Counts = { likes: number; reposts: number; replies: number; quotes: number; bookmarks: number; recent: number; impressions: number };
type History = { author_id: string; likes: number; reposts: number; replies: number; quotes: number; bookmarks: number; strength: number };
export type RankedRecommendation = Candidate & {
  score: number; conversation: string; socialProof: string[]; relationship: number;
  probabilities: { like: number; repost: number; reply: number; profile: number; authorReply: number; click: number; negative: number };
};
const blankCounts = (): Counts => ({ likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, recent: 0, impressions: 0 });
const clamp = (n: number) => Math.max(0, Math.min(0.95, n));

/** Original SQL/TS implementation of Home Mixer's stages; no upstream source code is used.
 * Design: https://github.com/twitter/the-algorithm/tree/main/home-mixer
 * Historical weights (April 5, 2023):
 * https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md
 * Unsupported video, two-minute dwell and report predictions are intentionally omitted.
 */
export const RECAP_WEIGHTS = { like: 0.5, repost: 1, reply: 13.5, profile: 12, authorReply: 75, click: 11, negative: -74 } as const;

// A shared event shape batches graph traversals and feature hydration. Quotes are
// distinct from replies, and bookmarks influence affinity without inventing a recap weight.
function events(since: number, filter: { actors?: string; posts?: string } = {}): string {
  const where = (actor: string, post: string) => `${filter.actors ? ` AND ${actor} ${filter.actors}` : ""}${filter.posts ? ` AND ${post} ${filter.posts}` : ""}`;
  const index = (name: string) => filter.posts ? ` INDEXED BY ${name}` : "";
  return `events AS (
    SELECT post_id,user_id,'likes' AS kind,created_at FROM likes${index("likes_post")} WHERE created_at>=${since}${where("user_id", "post_id")}
    UNION ALL SELECT post_id,user_id,'reposts',created_at FROM reposts${index("reposts_post")} WHERE created_at>=${since}${where("user_id", "post_id")}
    UNION ALL SELECT post_id,user_id,'bookmarks',created_at FROM bookmarks${index("bookmarks_post")} WHERE created_at>=${since}${where("user_id", "post_id")}
    UNION ALL SELECT reply_to_id,author_id,'replies',created_at FROM posts${index("posts_reply")} WHERE reply_to_id IS NOT NULL AND created_at>=${since}${where("author_id", "reply_to_id")}
    UNION ALL SELECT quote_id,author_id,'quotes',created_at FROM posts${index("posts_quote")} WHERE quote_id IS NOT NULL AND created_at>=${since}${where("author_id", "quote_id")}
  )`;
}

/** Ranking diagnostics stay server-side; the public feed contract contains no private features. */
export function rankForYou(viewerId: string | null, now = Date.now()): RankedRecommendation[] {
  const fresh = rankCandidates(viewerId, now, false);
  // Small networks can exhaust all unseen candidates. Keep the feed usable on
  // subsequent visits, with fatigue still reducing previously viewed posts' scores.
  return fresh.length ? fresh : rankCandidates(viewerId, now, true);
}

function rankCandidates(viewerId: string | null, now: number, includeSeen: boolean): RankedRecommendation[] {
  const since = now - 14 * DAY, historySince = now - 90 * DAY;
  const following = new Set(all<{ followee_id: string }>("SELECT followee_id FROM follows WHERE follower_id=?", viewerId).map(r => r.followee_id));
  const history = new Map(all<History>(`WITH ${events(historySince)} SELECT p.author_id,
    SUM(e.kind='likes') AS likes,SUM(e.kind='reposts') AS reposts,SUM(e.kind='replies') AS replies,
    SUM(e.kind='quotes') AS quotes,SUM(e.kind='bookmarks') AS bookmarks,
    SUM((CASE e.kind WHEN 'replies' THEN 4 WHEN 'reposts' THEN 3 WHEN 'quotes' THEN 2 WHEN 'bookmarks' THEN 2 ELSE 1 END)
      * (1.0/(1.0+(?-e.created_at)/${30 * DAY}.0))) AS strength
    FROM events e JOIN posts p ON p.id=e.post_id WHERE e.user_id=? GROUP BY p.author_id`, now, viewerId).map(r => [r.author_id, r]));
  const coldStart = !following.size && !history.size;
  const relationships = new Map([...history].map(([id, h]) => [id, 1 - Math.exp(-h.strength / 6)]));
  // Sparse interest vectors from engaged-with hashtags, analogous to SimClusters.
  // Two independent matching tags or several graph links are needed for strong proof.
  const tags = all<{ tag: string }>(`WITH ${events(historySince)} SELECT h.tag FROM events e
    JOIN hashtags h ON h.post_id=e.post_id WHERE e.user_id=? GROUP BY h.tag ORDER BY COUNT(*) DESC,h.tag LIMIT 12`, viewerId).map(r => r.tag);
  const neighbors = new Map(all<{ author_id: string; n: number }>(`SELECT f.followee_id AS author_id,COUNT(*) AS n
    FROM follows f JOIN follows mine ON mine.followee_id=f.follower_id WHERE mine.follower_id=?
    GROUP BY f.followee_id ORDER BY n DESC,f.followee_id LIMIT 150`, viewerId).map(r => [r.author_id, r.n]));
  const authorSimilarity = (id: string) => Math.min(1, (relationships.get(id) || 0) * 0.8 + Math.min(0.8, (neighbors.get(id) || 0) * 0.2));
  // Apply exclusions before source caps so seen/hidden posts cannot starve a pool.
  const eligible = `${discoveryFilter()} AND p.created_at>=${since} AND p.author_id IS NOT ?
    AND (${includeSeen ? 1 : 0}=1 OR NOT EXISTS(SELECT 1 FROM impressions i WHERE i.user_id=? AND i.post_id=p.id AND i.last_seen_at>=${now - DAY}))
    AND NOT EXISTS(SELECT 1 FROM negative_feedback n WHERE n.user_id=? AND n.post_id=p.id)`;
  const viewerArgs = [viewerId, viewerId, viewerId];
  const pool = new Map<string, Candidate>();
  type Row = { id: string; author_id: string; created_at: number; reply_to_id: string | null; reposterId?: string | null; matched?: number };
  const add = (rows: Row[], inNetwork = false) => {
    for (const row of rows) {
      const previous = pool.get(row.id);
      const similarity = Math.min(1, authorSimilarity(row.author_id) + Math.min(0.9, (row.matched || 0) * 0.3));
      pool.set(row.id, { ...row, reposterId: previous?.reposterId || row.reposterId || null,
        inNetwork: !!previous?.inNetwork || inNetwork || following.has(row.author_id),
        similarity: Math.max(previous?.similarity || 0, similarity) });
    }
  };
  // Earlybird-like in-network retrieval: independently capped originals and reposts.
  add(all<Row>(`SELECT p.* FROM posts p WHERE ${eligible} AND p.author_id IN
    (SELECT followee_id FROM follows WHERE follower_id=?) ORDER BY p.created_at DESC,p.id DESC LIMIT ${POOL}`, ...viewerArgs, viewerId), true);
  add(all<Row>(`SELECT p.*,r.user_id AS reposterId FROM reposts r JOIN posts p ON p.id=r.post_id
    WHERE ${eligible} AND r.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?)
    ORDER BY r.created_at DESC,r.user_id,p.id LIMIT ${POOL}`, ...viewerArgs, viewerId), true);
  // UTEG/GraphJet-like traversal: viewer -> followed actor -> engaged post.
  add(all<Row>(`WITH context AS (SELECT ? AS id), ${events(since, { actors: "IN (SELECT followee_id FROM follows WHERE follower_id=(SELECT id FROM context))" })}
    SELECT p.* FROM posts p JOIN events e ON e.post_id=p.id WHERE ${eligible}
    GROUP BY p.id ORDER BY COUNT(DISTINCT e.user_id) DESC,MAX(e.created_at) DESC,p.id LIMIT ${POOL}`, viewerId, ...viewerArgs));
  const similarAuthors = [...new Set([...relationships.keys(), ...neighbors.keys()])].filter(id => authorSimilarity(id) >= STRONG_SIMILARITY).slice(0, POOL);
  if (tags.length || similarAuthors.length) {
    const matches = tags.length ? `(SELECT COUNT(*) FROM hashtags h WHERE h.post_id=p.id AND h.tag IN (${placeholders(tags)}))` : "0";
    const authors = similarAuthors.length ? `p.author_id IN (${placeholders(similarAuthors)})` : "0";
    add(all<Row>(`SELECT p.*,${matches} AS matched FROM (SELECT p.* FROM posts p WHERE ${eligible}
      AND (${authors} OR ${tags.length ? `EXISTS(SELECT 1 FROM hashtags h WHERE h.post_id=p.id AND h.tag IN (${placeholders(tags)}))` : "0"})
      ORDER BY p.created_at DESC,p.id DESC LIMIT ${backendConfig().snapshotEntries}) p
      ORDER BY matched DESC,created_at DESC,id DESC LIMIT ${POOL}`, ...tags, ...viewerArgs, ...similarAuthors, ...tags));
  }
  // Cold-start exploration is the only exception to personalized out-of-network proof.
  if (coldStart) add(all<Row>(`SELECT p.* FROM (
    SELECT p.* FROM posts p WHERE ${eligible} ORDER BY p.created_at DESC,p.id DESC LIMIT ${backendConfig().snapshotEntries}
    ) p JOIN post_stats s ON s.post_id=p.id ORDER BY
    (s.likes+2*s.reposts+3*s.replies+2*s.bookmarks)
      /(1.0+(${now}-p.created_at)/${DAY}.0) DESC,p.created_at DESC,p.id DESC LIMIT ${POOL}`, ...viewerArgs));
  if (!pool.size) return [];
  const ids = [...pool.keys()], authors = [...new Set([...pool.values()].map(p => p.author_id))];
  const counts = new Map(ids.map(id => [id, blankCounts()]));
  const proof = new Map<string, Set<string>>();
  type EventCount = { post_id: string; kind: keyof Counts; n: number; recent: number };
  for (const row of all<EventCount>(`WITH ${events(historySince)} SELECT post_id,kind,COUNT(*) AS n,
    SUM(created_at>=?) AS recent FROM events WHERE post_id IN (${placeholders(ids)}) GROUP BY post_id,kind`, now - 6 * 3600000, ...ids)) {
    const c = counts.get(row.post_id)!; c[row.kind] = row.n; c.recent += row.recent;
  }
  for (const row of all<{ post_id: string; user_id: string }>(`WITH ${events(since)} SELECT DISTINCT e.post_id,e.user_id
    FROM events e JOIN follows f ON f.followee_id=e.user_id WHERE f.follower_id=? AND e.post_id IN (${placeholders(ids)})`, viewerId, ...ids)) {
    if (!proof.has(row.post_id)) proof.set(row.post_id, new Set());
    proof.get(row.post_id)!.add(row.user_id);
  }
  const impressions = new Map(all<{ post_id: string; n: number }>(`SELECT post_id,COUNT(*) AS n FROM impressions
    WHERE post_id IN (${placeholders(ids)}) GROUP BY post_id`, ...ids).map(r => [r.post_id, r.n]));
  const fatigue = new Map(all<{ post_id: string; seen_count: number }>(`SELECT post_id,seen_count FROM impressions
    WHERE user_id=? AND last_seen_at>=? AND post_id IN (${placeholders(ids)})`, viewerId, now - 30 * DAY, ...ids).map(r => [r.post_id, r.seen_count]));
  const media = new Set(all<{ post_id: string }>(`SELECT DISTINCT post_id FROM post_images WHERE post_id IN (${placeholders(ids)})`, ...ids).map(r => r.post_id));
  const mentions = new Set(all<{ post_id: string }>(`SELECT post_id FROM mentions WHERE user_id=? AND post_id IN (${placeholders(ids)})`, viewerId, ...ids).map(r => r.post_id));
  // A post newer than the 30-day author window cannot have valid interactions older than the 90-day event cutoff.
  // Aggregate its trigger-maintained counters rather than materializing all events.
  const authorCounts = new Map(all<{ author_id: string } & Counts>(`SELECT p.author_id,
    SUM(s.likes) likes,SUM(s.reposts) reposts,SUM(s.replies) replies,SUM(s.bookmarks) bookmarks,
    SUM((SELECT COUNT(*) FROM posts q WHERE q.quote_id=p.id)) quotes,0 recent,0 impressions
    FROM posts p JOIN post_stats s ON s.post_id=p.id WHERE p.created_at>=? AND p.author_id IN (${placeholders(authors)})
    GROUP BY p.author_id`, now - 30 * DAY, ...authors).map(r => [r.author_id, r]));
  const authorPosts = new Map(all<{ author_id: string; n: number }>(`SELECT author_id,COUNT(*) AS n FROM posts
    WHERE created_at>=? AND author_id IN (${placeholders(authors)}) GROUP BY author_id`, now - 30 * DAY, ...authors).map(r => [r.author_id, r.n]));
  const authorViews = new Map(all<{ author_id: string; n: number; mine: number }>(`SELECT p.author_id,COUNT(*) AS n,SUM(i.user_id=?) AS mine
    FROM impressions i JOIN posts p ON p.id=i.post_id WHERE p.author_id IN (${placeholders(authors)}) AND i.last_seen_at>=?
    GROUP BY p.author_id`, viewerId, ...authors, now - 90 * DAY).map(r => [r.author_id, r]));
  const feedback = new Map(all<{ author_id: string; n: number; last: number }>(`SELECT author_id,COUNT(*) AS n,MAX(created_at) AS last
    FROM negative_feedback WHERE user_id=? AND created_at>=? GROUP BY author_id`, viewerId, now - 30 * DAY).map(r => [r.author_id, r]));
  const reciprocal = new Map(all<{ user_id: string; n: number }>(`WITH context AS (SELECT ? AS id), ${events(historySince, { posts: "IN (SELECT id FROM posts WHERE author_id=(SELECT id FROM context))" })}
    SELECT e.user_id,COUNT(*) AS n FROM events e WHERE e.user_id IN (${placeholders(authors)}) GROUP BY e.user_id`, viewerId, ...authors).map(r => [r.user_id, r.n]));
  // Resolve full reply ancestry in one query. Siblings and nested replies share one key.
  // Corrupt cycles / chains deeper than 100 are discarded instead of repeated in the feed.
  const conversations = new Map(all<{ candidate: string; root: string }>(`WITH RECURSIVE chain(candidate,id,parent,depth,path) AS (
    SELECT id,id,reply_to_id,0,','||id||',' FROM posts WHERE id IN (${placeholders(ids)})
    UNION ALL SELECT c.candidate,p.id,p.reply_to_id,c.depth+1,c.path||p.id||',' FROM chain c JOIN posts p ON p.id=c.parent
    WHERE c.depth<100 AND instr(c.path,','||p.id||',')=0
  ) SELECT candidate,COALESCE(parent,id) AS root FROM chain
    WHERE parent IS NULL OR NOT EXISTS(SELECT 1 FROM posts p WHERE p.id=chain.parent)`, ...ids).map(r => [r.candidate, r.root]));
  const ranked: RankedRecommendation[] = [];
  for (const p of pool.values()) {
    const socialProof = [...(proof.get(p.id) || [])].sort();
    if (!p.inNetwork && !coldStart && !socialProof.length && p.similarity < STRONG_SIMILARITY) continue;
    const conversation = conversations.get(p.id);
    if (!conversation) continue;
    const c = counts.get(p.id)!, ac = authorCounts.get(p.author_id)!;
    c.impressions = impressions.get(p.id) || 0;
    const total = c.likes + c.reposts + c.replies + c.quotes + c.bookmarks;
    const authorTotal = ac.likes + ac.reposts + ac.replies + ac.quotes + ac.bookmarks;
    const relationship = Math.min(1, (relationships.get(p.author_id) || 0) + (following.has(p.author_id) ? 0.2 : 0));
    const affinity = 1 + 3 * relationship + 1.2 * p.similarity + Math.min(0.8, socialProof.length * 0.15) + (mentions.has(p.id) ? 0.4 : 0);
    const velocity = 1 + Math.min(0.5, c.recent / (6 + Math.max(1, (now - p.created_at) / 3600000)));
    // Impressions provide an exposure denominator; a conservative proxy handles sparse telemetry.
    const postExposure = Math.max(20, c.impressions, total * 3);
    const authorExposure = Math.max(20, authorViews.get(p.author_id)?.n || 0, (authorPosts.get(p.author_id) || 1) * 20, authorTotal * 3);
    const rate = (kind: "likes" | "reposts" | "replies" | "bookmarks" | "quotes", prior: number) => {
      const local = (c[kind] + 20 * prior) / (postExposure + 20);
      const author = (ac[kind] + 40 * prior) / (authorExposure + 40);
      const personal = ((history.get(p.author_id)?.[kind] || 0) + 20 * prior) / ((authorViews.get(p.author_id)?.mine || 0) + 20);
      return clamp((0.55 * local + 0.3 * author + 0.15 * personal) * affinity * velocity);
    };
    const like = clamp(rate("likes", 0.035) * (media.has(p.id) ? 1.1 : 1));
    const repost = clamp(rate("reposts", 0.012) + 0.5 * rate("quotes", 0.005));
    const reply = clamp(rate("replies", 0.008) * (p.reply_to_id ? 1.15 : 1));
    const bookmark = rate("bookmarks", 0.01);
    const negative = feedback.get(p.author_id);
    const probabilities = { like, repost, reply, profile: clamp(0.12 * like + 0.2 * reply),
      authorReply: clamp(reply * Math.min(0.7, 0.05 + 0.15 * relationship + 0.08 * (reciprocal.get(p.author_id) || 0))),
      click: clamp(0.25 * like + 0.5 * reply + 0.4 * bookmark),
      negative: negative ? negative.n / (negative.n + 3) * Math.exp(-(now - negative.last) / (7 * DAY)) : 0 };
    const weighted = (Object.keys(RECAP_WEIGHTS) as (keyof typeof RECAP_WEIGHTS)[]).reduce((sum, k) => sum + RECAP_WEIGHTS[k] * probabilities[k], 0);
    const decay = Math.exp(-Math.max(0, now - p.created_at) / (3 * DAY));
    // Keep negative penalties strong even on old posts; fatigue attenuates positive utility only.
    const score = (Math.max(0, weighted) / (1 + 0.25 * (fatigue.get(p.id) || 0)) + Math.min(0, weighted)) * decay;
    ranked.push({ ...p, conversation, socialProof, relationship, probabilities, score });
  }
  return mixRecommendations(ranked);
}

/** Home Mixer-style content balance + author diversity after heavy scoring. */
function mixRecommendations(candidates: RankedRecommendation[]): RankedRecommendation[] {
  const remaining = [...candidates].sort((a, b) => b.score - a.score || b.created_at - a.created_at || a.id.localeCompare(b.id));
  const result: RankedRecommendation[] = [], conversations = new Set<string>(), authorCounts = new Map<string, number>();
  let inCount = 0, outCount = 0;
  while (remaining.length) {
    const last = result.at(-1), previous = result.at(-2);
    const available = remaining.filter(p => !conversations.has(p.conversation) && !(last?.author_id === p.author_id && previous?.author_id === p.author_id));
    if (!available.length) break; // Never pad a feed with a third consecutive post from one author.
    const desiredIn = inCount <= outCount;
    const balanced = available.filter(p => p.inNetwork === desiredIn);
    const options = balanced.length ? balanced : available;
    const utility = (p: RankedRecommendation) => p.score - Math.abs(p.score) * Math.min(0.8, 0.15 * (authorCounts.get(p.author_id) || 0))
      - (last?.author_id === p.author_id ? Math.abs(p.score) * 0.3 : 0);
    const chosen = options.reduce((best, p) => utility(p) > utility(best) ? p : best);
    result.push(chosen); conversations.add(chosen.conversation);
    authorCounts.set(chosen.author_id, (authorCounts.get(chosen.author_id) || 0) + 1);
    if (chosen.inNetwork) inCount++; else outCount++;
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return result;
}

export function recommendedEntries(viewerId: string | null): RecommendationEntry[] {
  return rankForYou(viewerId).map(p => ({ key: `post:${p.id}`, postId: p.id, reposterId: p.reposterId }));
}

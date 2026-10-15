import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { POST_MAX_IMAGES, POST_MAX_LENGTH } from "../../lib/types";
import { getDb, transaction } from "../db";
import { insertPost, type NewPost } from "../data/posts";
import { AppError } from "../errors";
import { getClassifier } from "./classifier";
import { moderationConfig } from "./config";
import { classifyGuard, type GuardResult } from "./guard";
import { getSlurMatcher, hasPublishBlock } from "./lexicon";
import { FEATURE_VERSION, type Scores } from "./linear";
import { isDirectedAtAnother, recordTier0 } from "./policy";
import type { SlurHit } from "./slurs";

export const CONTENT_REJECTION = "This content isn't allowed";
type Assessment = { hits: SlurHit[]; lexicon: string; lexicalMs: number; scores: Scores | Record<string, never>;
  weights: string; linearMs: number; guard: GuardResult; model: string };
function store(itemId: string, itemType: string, revision: string, text: string, result: Assessment): number {
  const db = getDb(), now = Date.now(), hash = createHash("sha256").update(text).digest("hex");
  const lexicalId = recordTier0(itemId, itemType, revision, text, result.hits, result.lexicon, result.lexicalMs);
  const insert = db.prepare(`INSERT INTO moderation_results(item_id,item_type,revision,content_hash,tier,scores,guard_verdict,guard_categories,model_version,weights_version,status,latency_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(itemId, itemType, revision, hash, 1, JSON.stringify(result.scores), null, "[]", FEATURE_VERSION, result.weights,
    result.weights === "unavailable" ? "weights_unavailable" : "ok", result.linearMs, now);
  insert.run(itemId, itemType, revision, hash, 2, JSON.stringify(result.scores), result.guard.verdict, JSON.stringify(result.guard.categories),
    result.model, result.weights, result.guard.status, result.guard.latencyMs, now);
  return lexicalId;
}

/** Both the composer and REST/MCP writes enter here. Never hold SQLite open during HTTP. */
export async function publishPost(authorId: string, input: NewPost): Promise<string> {
  const config = moderationConfig();
  if (!config.enabled || config.publish === "off") return insertPost(authorId, input);
  const text = input.content.trim();
  // Reject invalid drafts before spending guard capacity or persisting an assessment.
  if ([...text].length > POST_MAX_LENGTH) throw new Error(`Posts can be at most ${POST_MAX_LENGTH} characters`);
  if (!text && !input.imageUrls?.length && !input.mediaIds?.length && !input.quoteId) throw new Error("Write something or add an image");
  if ((input.imageUrls?.length ?? 0) + (input.mediaIds?.length ?? 0) > POST_MAX_IMAGES ||
      new Set(input.mediaIds).size !== (input.mediaIds?.length ?? 0) ||
      input.imageUrls?.some(url => !/^\/api\/media\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(url))) throw new Error("Invalid images");
  const matcher = getSlurMatcher(), start = performance.now(), hits = matcher.match(text);
  const lexicalMs = performance.now() - start;
  const itemType = input.replyToId ? "reply" : input.quoteId ? "quote" : "post";
  if (hasPublishBlock(hits)) {
    transaction(() => recordTier0(`rejected:${randomUUID()}`, itemType, randomUUID(), text, hits, matcher.version, lexicalMs, "rejected_publish_term"));
    throw new AppError(400, "moderated_text", CONTENT_REJECTION);
  }
  const linearStart = performance.now();
  let scores: Assessment["scores"] = {}, weights = "unavailable";
  try { const classifier = getClassifier(); scores = classifier.score(text, hits); weights = classifier.version; } catch { /* Guard can still classify without weights. */ }
  const linearMs = performance.now() - linearStart;
  // Blocking publication deliberately checks every draft, independently of background escalation.
  const guard = await classifyGuard(text, config, hits);
  const result: Assessment = { hits, lexicon: matcher.version, lexicalMs, scores, weights, linearMs, guard, model: config.guardVersion };
  if (guard.status !== "ok" || guard.verdict === "unknown" || guard.verdict === "Unsafe") {
    transaction(() => store(`rejected:${randomUUID()}`, itemType, randomUUID(), text, result));
    if (guard.status === "ok" && guard.verdict === "Unsafe") throw new AppError(400, "moderated_text", CONTENT_REJECTION);
    throw new AppError(503, "moderation_unavailable", "Content check is temporarily unavailable. Your post wasn't sent. Please try again.", { retryAfter: 5 });
  }
  // Safe and Controversial may publish. Ambiguous/reclaimed language alone never rejects.
  return transaction(() => {
    const id = insertPost(authorId, input), db = getDb();
    const job = db.prepare("SELECT revision FROM moderation_jobs WHERE item_id=? AND item_type=?").get(id, itemType);
    const revision = String(job?.revision ?? randomUUID());
    const lexicalId = store(id, itemType, revision, text, result);
    if (hits.some(h => h.entry.severity === "high")) {
      db.prepare(`INSERT INTO moderation_reviews(revision,item_id,item_type,result_id,recommendation,state,created_at,reviewed_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(revision, id, itemType, lexicalId, isDirectedAtAnother(authorId, text, input.replyToId) ? "hold" : "reduce_reach",
          guard.verdict === "Safe" ? "approved" : "pending", Date.now(), guard.verdict === "Safe" ? Date.now() : null);
    }
    // Reuse the completed assessment instead of asking the background guard a second time.
    db.prepare("DELETE FROM moderation_jobs WHERE item_id=? AND item_type=?").run(id, itemType);
    return id;
  });
}

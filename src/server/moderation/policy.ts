import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db";
import { AppError } from "../errors";
import { moderationConfig } from "./config";
import { getSlurMatcher } from "./lexicon";
import { NORMALIZER_VERSION } from "./normalize";
import { slurSignals, type SlurHit } from "./slurs";

export const SLUR_REJECTION = "This post contains a term that isn't allowed";
export function recordTier0(itemId: string, itemType: string, revision: string, text: string, hits: SlurHit[], version: string, latencyMs: number, status = "ok"): number {
  const signals = slurSignals(hits);
  getDb().prepare(`INSERT OR IGNORE INTO moderation_results(item_id,item_type,revision,content_hash,tier,scores,guard_categories,model_version,weights_version,status,latency_ms,created_at,hits)
    VALUES(?,?,?,?,0,?,'[]',?,?,?,?,?,?)`).run(itemId, itemType, revision, createHash("sha256").update(text).digest("hex"), JSON.stringify(signals),
    `aho-corasick:${NORMALIZER_VERSION}`, version, status, latencyMs, Date.now(), JSON.stringify(hits));
  return Number(getDb().prepare("SELECT id FROM moderation_results WHERE revision=? AND tier=0").get(revision)!.id);
}
export function assertNameAllowed(text: string, itemType: "username" | "display_name", itemId?: string): void {
  const config = moderationConfig();
  if (!config.enabled || config.slurNames !== "reject") return;
  const start = performance.now(), matcher = getSlurMatcher(), hits = matcher.match(text, true);
  if (hits.some(hit => hit.entry.severity === "high")) {
    recordTier0(itemId ?? `rejected:${randomUUID()}`, itemType, randomUUID(), text, hits, matcher.version, performance.now() - start, "rejected_name");
    throw new AppError(400, "moderated_name", "This name contains a term that isn't allowed");
  }
}
export function isDirectedAtAnother(authorId: string, text: string, replyTo?: string | null): boolean {
  const db = getDb();
  if (replyTo && db.prepare("SELECT 1 FROM posts WHERE id=? AND author_id<>?").get(replyTo, authorId)) return true;
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)) {
    if (db.prepare("SELECT 1 FROM users WHERE username_lower=? AND id<>?").get(m[1].toLowerCase(), authorId)) return true;
  }
  return false;
}
export function assertDirectedPostAllowed(authorId: string, text: string, replyTo?: string | null): void {
  const config = moderationConfig();
  if (!config.enabled || config.slurAction !== "reject-directed" || !isDirectedAtAnother(authorId, text, replyTo)) return;
  const start = performance.now(), matcher = getSlurMatcher(), hits = matcher.match(text);
  if (hits.some(h => h.entry.severity === "high")) {
    recordTier0(`rejected:${randomUUID()}`, replyTo ? "reply" : "post", randomUUID(), text, hits, matcher.version, performance.now() - start, "rejected_directed");
    throw new AppError(400, "moderated_text", SLUR_REJECTION);
  }
}
/** A pending directed review is a reversible hold only when the operator opts in. */
export function heldPostFilter(alias = "p"): string {
  const config = moderationConfig();
  return config.enabled && config.slurAction !== "shadow"
    ? `NOT EXISTS(SELECT 1 FROM moderation_reviews mr WHERE mr.item_id=${alias}.id AND mr.recommendation='hold' AND mr.state IN ('pending','restricted'))` : "1=1";
}
export function slurDiscoveryFilter(alias = "p"): string {
  const config = moderationConfig();
  return config.enabled && config.slurAction !== "shadow"
    ? `NOT EXISTS(SELECT 1 FROM moderation_reviews mr WHERE mr.item_id=${alias}.id AND mr.state IN ('pending','restricted'))` : "1=1";
}

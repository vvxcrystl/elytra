import "server-only";
import { createHash } from "node:crypto";
import { getDb, transaction } from "../db";
import { moderationConfig } from "./config";
import { getClassifier } from "./classifier";
import { classifyGuard, shouldEscalate, type GuardResult } from "./guard";
import { FEATURE_VERSION, type Scores } from "./linear";
import { getSlurMatcher } from "./lexicon";
import { isDirectedAtAnother, recordTier0, slurDiscoveryFilter } from "./policy";
import type { SlurHit } from "./slurs";

type Job = { id: number; revision: string; item_id: string; item_type: string; text: string; tier: number; scores: string | null; weights_version: string | null };
type Worker = { timer?: ReturnType<typeof setInterval>; active: Set<number>; running: boolean };
const shared = globalThis as typeof globalThis & { elytraModerationWorker?: Worker };
const state = () => shared.elytraModerationWorker ??= { active: new Set(), running: false };
const postType = (type: string) => ["post", "reply", "quote"].includes(type);

function record(job: Job, tier: number, scores: Scores | Record<string, never>, version: string, latency: number, status: string, guard?: GuardResult): number {
  const config = moderationConfig();
  const row = getDb().prepare(`INSERT OR IGNORE INTO moderation_results
    (item_id,item_type,revision,content_hash,tier,scores,guard_verdict,guard_categories,model_version,weights_version,status,latency_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.item_id, job.item_type, job.revision, createHash("sha256").update(job.text).digest("hex"), tier,
    JSON.stringify(scores), guard?.verdict ?? null, JSON.stringify(guard?.categories ?? []),
    tier === 1 ? FEATURE_VERSION : config.guardVersion, version, status, latency, Date.now());
  return Number(row.lastInsertRowid);
}
function finishGuard(job: Job, scores: Scores, guard: GuardResult) {
  transaction(() => {
    // A deletion while HTTP was in flight must not recreate audit rows or exclusions.
    // SQLite may reuse a deleted INTEGER PRIMARY KEY for a newer job.
    if (!getDb().prepare("SELECT 1 FROM moderation_jobs WHERE id=? AND revision=?").get(job.id, job.revision)) return;
    const resultId = record(job, 2, scores, job.weights_version!, guard.latencyMs, guard.status, guard);
    const config = moderationConfig();
    if (guard.status === "ok" && (guard.verdict === "Safe" || guard.verdict === "Unsafe")) {
      getDb().prepare("UPDATE moderation_reviews SET state=?,reviewed_at=? WHERE revision=? AND state='pending'")
        .run(guard.verdict === "Safe" ? "approved" : "restricted", Date.now(), job.revision);
    }
    if (config.enabled && config.enforcement === "discovery" && postType(job.item_type) && guard.verdict === "Unsafe" &&
        guard.status === "ok" && (guard.categories.includes("Violent") || guard.categories.includes("Unethical Acts")) &&
        Math.max(...Object.values(scores)) >= config.enforceMin) {
      getDb().prepare("INSERT OR REPLACE INTO moderation_exclusions(post_id,result_id,created_at) VALUES(?,?,?)").run(job.item_id, resultId, Date.now());
    }
    getDb().prepare("DELETE FROM moderation_jobs WHERE id=?").run(job.id);
  });
}
/** Processes a bounded batch; no inference runs in the publishing transaction. */
export function drainModeration(): void {
  const config = moderationConfig(), worker = state();
  if (!config.enabled || worker.running) return;
  worker.running = true;
  try {
    const excluded = [...worker.active];
    const jobs = getDb().prepare(`SELECT * FROM moderation_jobs ${excluded.length ? `WHERE id NOT IN (${excluded.map(() => "?").join()})` : ""} ORDER BY id LIMIT 32`).all(...excluded) as unknown as Job[];
    for (const job of jobs) {
      let scores: Scores;
      const priorTier0 = getDb().prepare("SELECT hits FROM moderation_results WHERE revision=? AND tier=0").get(job.revision);
      let hits = JSON.parse(String(priorTier0?.hits ?? "[]")) as SlurHit[];
      if (!priorTier0) {
        const start = performance.now(), matcher = getSlurMatcher();
        hits = matcher.match(job.text, ["username", "display_name"].includes(job.item_type));
        const latency = performance.now() - start;
        transaction(() => {
          const resultId = recordTier0(job.item_id, job.item_type, job.revision, job.text, hits, matcher.version, latency);
          if (postType(job.item_type) && hits.some(h => h.entry.severity === "high")) {
            const post = getDb().prepare("SELECT author_id,reply_to_id FROM posts WHERE id=?").get(job.item_id);
            if (post) {
              const directed = isDirectedAtAnother(String(post.author_id), job.text, post.reply_to_id as string | null);
              getDb().prepare("INSERT OR IGNORE INTO moderation_reviews(revision,item_id,item_type,result_id,recommendation,created_at) VALUES(?,?,?,?,?,?)")
                .run(job.revision, job.item_id, job.item_type, resultId, directed ? "hold" : "reduce_reach", Date.now());
            }
          }
        });
      }
      if (job.tier === 1) {
        const start = performance.now();
        let version: string;
        try { const classifier = getClassifier(); scores = classifier.score(job.text, hits); version = classifier.version; }
        catch {
          transaction(() => { record(job, 1, {}, "unavailable", performance.now() - start, "weights_unavailable"); getDb().prepare("DELETE FROM moderation_jobs WHERE id=?").run(job.id); });
          continue;
        }
        const latency = performance.now() - start;
        const escalate = config.escalation !== "off" && (shouldEscalate(scores, config) || hits.some(h => h.entry.severity === "high") ||
          (hits.some(h => h.entry.severity === "ambiguous") && Math.max(...Object.values(scores)) >= config.low));
        transaction(() => {
          record(job, 1, scores, version, latency, "ok");
          if (escalate) getDb().prepare("UPDATE moderation_jobs SET tier=2,scores=?,weights_version=? WHERE id=?").run(JSON.stringify(scores), version, job.id);
          else getDb().prepare("DELETE FROM moderation_jobs WHERE id=?").run(job.id);
        });
        if (!escalate) continue;
        job.weights_version = version;
      } else scores = JSON.parse(job.scores!) as Scores;
      if (config.escalation === "off" || worker.active.size >= config.queue + 1) {
        finishGuard(job, scores, { verdict: "unknown", categories: [], status: config.escalation === "off" ? "disabled" : "overloaded", latencyMs: 0 });
        continue;
      }
      worker.active.add(job.id);
      void classifyGuard(job.text, config, hits).then(result => finishGuard(job, scores, result))
        .catch(() => { console.error("Moderation result could not be stored; job retained for retry"); })
        .finally(() => { worker.active.delete(job.id); });
    }
  } finally { worker.running = false; }
}
export function startModerationWorker(): void {
  const worker = state();
  if (worker.timer || !moderationConfig().enabled) return;
  // Fail early on bad configuration, but missing weights never prevent startup or publishing.
  getSlurMatcher();
  try { getClassifier(); } catch { console.error("Moderation weights unavailable; check ELYTRA_MODERATION_WEIGHTS"); }
  worker.timer = setInterval(() => {
    try { drainModeration(); } catch { console.error("Moderation batch failed; durable jobs retained for retry"); }
  }, 250);
  worker.timer.unref();
}
export function stopModerationWorker(): void { clearInterval(state().timer); state().timer = undefined; }
export function moderationPending(): number { return state().active.size + Number(getDb().prepare("SELECT count(*) AS n FROM moderation_jobs").get()!.n); }

/** Only discovery surfaces consult this. Turning enforcement off restores visibility immediately. */
export function discoveryFilter(alias = "p"): string {
  const config = moderationConfig();
  const guard = config.enabled && config.enforcement === "discovery"
    ? `NOT EXISTS(SELECT 1 FROM moderation_exclusions me WHERE me.post_id=${alias}.id)` : "1=1";
  return `${guard} AND ${slurDiscoveryFilter(alias)}`;
}

import "server-only";
import { getDb } from "../db";
import { seedEntries, getSeedMatcher, SlurMatcher, type SlurEntry, type SlurHit } from "./slurs";
import { normalizeText } from "./normalize";
import { SEED_VERSION } from "./slur-seed";

const shared = globalThis as typeof globalThis & { elytraSlurLexicon?: { version: number; matcher: SlurMatcher; rejectPublish?: ReadonlySet<string> } };
const entryKey = (term: string, lang: string) => `${normalizeText(term)}:${lang}`;
/** Check the cheap version counter, rebuilding once only after an admin edit. */
export function getSlurMatcher(): SlurMatcher {
  const cached = shared.elytraSlurLexicon;
  const db = getDb(), version = Number(db.prepare("SELECT version FROM moderation_lexicon_version WHERE id=1").get()!.version);
  if (cached?.version === version && cached.rejectPublish) return cached.matcher;
  try {
    const entries = new Map(seedEntries.map(e => [`${normalizeText(e.term)}:${e.lang}`, e]));
    const rejectPublish = new Set<string>();
    const rows = db.prepare("SELECT * FROM moderation_slur_overrides ORDER BY term,lang LIMIT 4097").all();
    if (rows.length > 4096) throw new Error("Slur overrides exceed 4096 entries");
    for (const row of rows) {
      const key = `${normalizeText(String(row.term))}:${row.lang}`;
      rejectPublish.delete(key);
      if (!row.enabled) { entries.delete(key); continue; }
      if (row.reject_publish === 1) rejectPublish.add(key);
      const existing = entries.get(key);
      entries.set(key, { term: String(row.term), lang: String(row.lang), severity: row.severity ?? existing?.severity,
        category: row.category ?? existing?.category, match: row.match ?? existing?.match ?? "word",
        exceptions: [...new Set([...(existing?.exceptions ?? []), ...JSON.parse(String(row.exceptions))])],
        source: String(row.source), substringAudit: row.substring_audit ? String(row.substring_audit) : undefined } as SlurEntry);
    }
    const matcher = new SlurMatcher([...entries.values()], `${SEED_VERSION}:admin-${version}`);
    shared.elytraSlurLexicon = { version, matcher, rejectPublish };
    return matcher;
  } catch {
    console.error("Invalid moderation slur overrides; keeping the previous valid lexicon until the next edit");
    const matcher = cached?.matcher ?? getSeedMatcher();
    shared.elytraSlurLexicon = { version, matcher, rejectPublish: cached?.rejectPublish ?? new Set() };
    return matcher;
  }
}

/** Explicit operator policy is separate from contextual/reclaimed severity and model features. */
export function hasPublishBlock(hits: readonly SlurHit[]): boolean {
  getSlurMatcher();
  return hits.some(hit => shared.elytraSlurLexicon?.rejectPublish?.has(entryKey(hit.entry.term, hit.entry.lang)));
}

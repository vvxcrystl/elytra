import type { DatabaseSync } from "node:sqlite";

export const moderationResultsSchema = (table: string) => `CREATE TABLE ${table} (
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK(item_type IN ('post','reply','quote','username','display_name','bio')),
  revision TEXT NOT NULL, content_hash TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK(tier IN (0,1,2)), scores TEXT NOT NULL CHECK(json_valid(scores)),
  guard_verdict TEXT CHECK(guard_verdict IN ('Safe','Controversial','Unsafe','unknown')),
  guard_categories TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(guard_categories)),
  model_version TEXT NOT NULL, weights_version TEXT NOT NULL, status TEXT NOT NULL,
  latency_ms REAL NOT NULL, created_at INTEGER NOT NULL, hits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(hits)), UNIQUE(revision,tier)
)`;
/** Widen v1 CHECK constraints without losing history, child FK rows, IDs, or delete triggers. */
export function migrateModerationResults(db: DatabaseSync): void {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='moderation_results'").get()?.sql;
  if (!schema) { db.exec(moderationResultsSchema("moderation_results")); return; }
  if (String(schema).includes("(0,1,2)")) return;
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys);
  const legacy = Number(db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table);
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE");
  try {
    db.exec(moderationResultsSchema("moderation_results_v2"));
    db.exec(`INSERT INTO moderation_results_v2(id,item_id,item_type,revision,content_hash,tier,scores,guard_verdict,guard_categories,model_version,weights_version,status,latency_ms,created_at)
      SELECT id,item_id,item_type,revision,content_hash,tier,scores,guard_verdict,guard_categories,model_version,weights_version,status,latency_ms,created_at FROM moderation_results;
      DROP TABLE moderation_results;
      ALTER TABLE moderation_results_v2 RENAME TO moderation_results;`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Moderation migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA legacy_alter_table=${legacy}; PRAGMA foreign_keys=${foreignKeys}`); }
}

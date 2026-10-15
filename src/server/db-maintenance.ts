import type { DatabaseSync } from "node:sqlite";

const lastRun = new WeakMap<DatabaseSync, number>();
/** At most 1,500 expired rows per second per process; never sweep a whole table. */
export function maintainDatabase(db: DatabaseSync, now = Date.now()): void {
  if (now - (lastRun.get(db) ?? -Infinity) < 1000) return;
  lastRun.set(db, now);
  for (const [table, column, cutoff] of [
    ["sessions", "expires_at", now],
    ["api_rate_limits", "reset_at", now],
    ["timeline_snapshots", "created_at", now - 86400000],
  ] as const) {
    db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column}<=? LIMIT 500)`).run(cutoff);
  }
}

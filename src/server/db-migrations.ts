import type { DatabaseSync } from "node:sqlite";

/** Counters replace repeated fan-out scans on popular posts. Triggers cover every writer. */
export function migrateBackend(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS backend_migrations(id TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS snapshots_viewer_time ON timeline_snapshots(viewer_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS snapshots_viewer_source ON timeline_snapshots(viewer_id,source,created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS notifications_identity ON notifications(user_id,actor_id,type,post_id);
    CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(user_id,read,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS notifications_page ON notifications(user_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS likes_time ON likes(created_at,post_id,user_id);
    CREATE INDEX IF NOT EXISTS reposts_time ON reposts(created_at,post_id,user_id);
    CREATE INDEX IF NOT EXISTS bookmarks_time ON bookmarks(created_at,post_id,user_id);
    CREATE INDEX IF NOT EXISTS posts_author_page ON posts(author_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS likes_user_time ON likes(user_id,created_at DESC,post_id);
    CREATE INDEX IF NOT EXISTS reposts_user_time ON reposts(user_id,created_at DESC,post_id);
    CREATE INDEX IF NOT EXISTS bookmarks_user_time ON bookmarks(user_id,created_at DESC,post_id);
    CREATE TABLE IF NOT EXISTS post_stats (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      likes INTEGER NOT NULL DEFAULT 0, reposts INTEGER NOT NULL DEFAULT 0,
      bookmarks INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0
    );`);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM backend_migrations WHERE id='post_stats_v1'").get()) {
      db.exec(`INSERT OR REPLACE INTO post_stats(post_id,likes,reposts,bookmarks,replies)
        SELECT p.id,COALESCE(l.n,0),COALESCE(r.n,0),COALESCE(b.n,0),COALESCE(c.n,0) FROM posts p
        LEFT JOIN (SELECT post_id,COUNT(*) n FROM likes GROUP BY post_id) l ON l.post_id=p.id
        LEFT JOIN (SELECT post_id,COUNT(*) n FROM reposts GROUP BY post_id) r ON r.post_id=p.id
        LEFT JOIN (SELECT post_id,COUNT(*) n FROM bookmarks GROUP BY post_id) b ON b.post_id=p.id
        LEFT JOIN (SELECT reply_to_id,COUNT(*) n FROM posts WHERE reply_to_id IS NOT NULL GROUP BY reply_to_id) c ON c.reply_to_id=p.id;
        INSERT INTO backend_migrations VALUES('post_stats_v1');`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS post_stats_insert AFTER INSERT ON posts BEGIN
        INSERT INTO post_stats(post_id) VALUES(NEW.id);
        UPDATE post_stats SET replies=replies+1 WHERE post_id=NEW.reply_to_id;
      END;
      CREATE TRIGGER IF NOT EXISTS post_stats_delete AFTER DELETE ON posts BEGIN
        UPDATE post_stats SET replies=replies-1 WHERE post_id=OLD.reply_to_id;
      END;
      CREATE TRIGGER IF NOT EXISTS post_stats_parent AFTER UPDATE OF reply_to_id ON posts WHEN OLD.reply_to_id IS NOT NEW.reply_to_id BEGIN
        UPDATE post_stats SET replies=replies-1 WHERE post_id=OLD.reply_to_id;
        UPDATE post_stats SET replies=replies+1 WHERE post_id=NEW.reply_to_id;
      END;`);
    for (const table of ["likes", "reposts", "bookmarks"] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS post_stats_${table}_insert AFTER INSERT ON ${table} BEGIN
          UPDATE post_stats SET ${table}=${table}+1 WHERE post_id=NEW.post_id;
        END;
        CREATE TRIGGER IF NOT EXISTS post_stats_${table}_delete AFTER DELETE ON ${table} BEGIN
          UPDATE post_stats SET ${table}=${table}-1 WHERE post_id=OLD.post_id;
        END;`);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

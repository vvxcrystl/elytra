import type { DatabaseSync } from "node:sqlite";
import { migrateModerationResults } from "./moderation/migration";

/** Counters replace repeated fan-out scans on popular posts. Triggers cover every writer.
 * This runs after the message-privacy rebuild, so it is the right home for message column adds. */
export function migrateBackend(db: DatabaseSync): void {
  migrateModerationResults(db);
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!messageColumns.includes("deleted")) {
    // Deleted DMs stay behind as client-ID tombstones so a replayed signed envelope cannot recreate them.
    db.exec("ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
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
      bookmarks INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0, detail_expands INTEGER NOT NULL DEFAULT 0, profile_visits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS post_visits (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('detail','profile')),
      last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(post_id,user_id,kind)
    );
    CREATE INDEX IF NOT EXISTS post_visits_user ON post_visits(user_id);
    CREATE INDEX IF NOT EXISTS moderation_item ON moderation_results(item_id,item_type,created_at DESC);
    CREATE TABLE IF NOT EXISTS moderation_jobs (
      id INTEGER PRIMARY KEY, revision TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL, item_type TEXT NOT NULL,
      text TEXT NOT NULL, tier INTEGER NOT NULL DEFAULT 1, scores TEXT, weights_version TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moderation_exclusions (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      result_id INTEGER NOT NULL REFERENCES moderation_results(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moderation_lexicon_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
    INSERT OR IGNORE INTO moderation_lexicon_version VALUES(1,0);
    CREATE TABLE IF NOT EXISTS moderation_slur_overrides (
      term TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en', severity TEXT CHECK(severity IN ('high','ambiguous')),
      category TEXT, match TEXT DEFAULT 'word' CHECK(match IN ('word','substring')),
      exceptions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(exceptions)), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      source TEXT NOT NULL DEFAULT 'local admin', substring_audit TEXT,
      reject_publish INTEGER NOT NULL DEFAULT 0 CHECK(reject_publish IN (0,1)), PRIMARY KEY(term,lang)
    );
    CREATE TRIGGER IF NOT EXISTS moderation_lexicon_insert AFTER INSERT ON moderation_slur_overrides BEGIN
      UPDATE moderation_lexicon_version SET version=version+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_lexicon_update AFTER UPDATE ON moderation_slur_overrides BEGIN
      UPDATE moderation_lexicon_version SET version=version+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_lexicon_delete AFTER DELETE ON moderation_slur_overrides BEGIN
      UPDATE moderation_lexicon_version SET version=version+1 WHERE id=1;
    END;
    CREATE TABLE IF NOT EXISTS moderation_reviews (
      revision TEXT PRIMARY KEY, item_id TEXT NOT NULL, item_type TEXT NOT NULL,
      result_id INTEGER NOT NULL REFERENCES moderation_results(id) ON DELETE CASCADE,
      recommendation TEXT NOT NULL CHECK(recommendation IN ('hold','reduce_reach')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','restricted')),
      created_at INTEGER NOT NULL, reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS moderation_review_item ON moderation_reviews(item_id,state);
    CREATE TRIGGER IF NOT EXISTS moderation_post_insert AFTER INSERT ON posts WHEN moderation_enabled()=1 BEGIN
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at)
      VALUES(lower(hex(randomblob(16))),NEW.id,CASE WHEN NEW.reply_to_id IS NOT NULL THEN 'reply' WHEN NEW.quote_id IS NOT NULL THEN 'quote' ELSE 'post' END,NEW.content,unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_username_insert AFTER INSERT ON users WHEN moderation_enabled()=1 BEGIN
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,'username',NEW.username,unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_user_insert AFTER INSERT ON users WHEN moderation_enabled()=1 BEGIN
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,'display_name',NEW.display_name,unixepoch()*1000);
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,'bio',NEW.bio,unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_display_name_update AFTER UPDATE OF display_name ON users
      WHEN moderation_enabled()=1 AND OLD.display_name IS NOT NEW.display_name BEGIN
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,'display_name',NEW.display_name,unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_bio_update AFTER UPDATE OF bio ON users
      WHEN moderation_enabled()=1 AND OLD.bio IS NOT NEW.bio BEGIN
      INSERT INTO moderation_jobs(revision,item_id,item_type,text,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,'bio',NEW.bio,unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS moderation_post_delete AFTER DELETE ON posts BEGIN
      DELETE FROM moderation_jobs WHERE item_id=OLD.id AND item_type IN ('post','reply','quote');
      DELETE FROM moderation_results WHERE item_id=OLD.id AND item_type IN ('post','reply','quote');
    END;
    DROP TRIGGER IF EXISTS moderation_user_delete;
    CREATE TRIGGER moderation_user_delete AFTER DELETE ON users BEGIN
      DELETE FROM moderation_jobs WHERE item_id=OLD.id AND item_type IN ('username','display_name','bio');
      DELETE FROM moderation_results WHERE item_id=OLD.id AND item_type IN ('username','display_name','bio');
    END;`);
  const overrideColumns = db.prepare("PRAGMA table_info(moderation_slur_overrides)").all().map(c => c.name);
  if (!overrideColumns.includes("reject_publish")) db.exec("ALTER TABLE moderation_slur_overrides ADD COLUMN reject_publish INTEGER NOT NULL DEFAULT 0 CHECK(reject_publish IN (0,1))");
  // Databases created before post analytics lack the view counters.
  const statColumns = db.prepare("PRAGMA table_info(post_stats)").all().map(c => c.name);
  for (const column of ["views", "detail_expands", "profile_visits"]) {
    if (!statColumns.includes(column)) db.exec(`ALTER TABLE post_stats ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
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
    // Views are the viewers' impressions, not counting the author's own.
    if (!db.prepare("SELECT 1 FROM backend_migrations WHERE id='post_views_v1'").get()) {
      db.exec(`UPDATE post_stats SET views=COALESCE((SELECT SUM(i.seen_count) FROM impressions i JOIN posts p ON p.id=i.post_id
          WHERE i.post_id=post_stats.post_id AND i.user_id<>p.author_id),0);
        INSERT INTO backend_migrations VALUES('post_views_v1');`);
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

import "server-only";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { seedDatabase } from "./seed";
import { migrateMessageStorage } from "./message-migration";
import { migrateBackend } from "./db-migrations";
import { backendConfig } from "./config";

const globalDb = globalThis as typeof globalThis & { elytraDb?: DatabaseSync };
// A module-local guard runs additive migrations again after HMR even if the
// running dev server keeps its original connection on globalThis.
const configured = new WeakSet<DatabaseSync>();
function initializeDatabase(db: DatabaseSync): void {
  db.function("unicode_lower", { deterministic: true }, value => String(value ?? "").toLowerCase());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${backendConfig().busyTimeoutMs};
    PRAGMA cache_size = -16384;
    PRAGMA journal_size_limit = 67108864;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', avatar_url TEXT,
      banner_url TEXT, created_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      ai_operated INTEGER NOT NULL DEFAULT 0, ai_operated_override INTEGER CHECK(ai_operated_override IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL, reply_to_id TEXT, quote_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_images (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, url TEXT NOT NULL,
      position INTEGER NOT NULL, PRIMARY KEY(post_id, position)
    );
    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS reposts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(follower_id, followee_id), CHECK(follower_id <> followee_id)
    );
    CREATE TABLE IF NOT EXISTS hashtags (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, tag TEXT NOT NULL,
      PRIMARY KEY(post_id, tag)
    );
    CREATE TABLE IF NOT EXISTS mentions (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('like','repost','follow','reply','mention','quote')),
      post_id TEXT REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS timeline_snapshots (
      id TEXT PRIMARY KEY, viewer_id TEXT, source TEXT NOT NULL, entries TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS impressions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS negative_feedback (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS blocks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,target_id), CHECK(user_id <> target_id)
    );
    CREATE TABLE IF NOT EXISTS mutes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,target_id), CHECK(user_id <> target_id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_a,user_b), CHECK(user_a < user_b)
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT, envelope TEXT, legacy_removed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, UNIQUE(conversation_id,sender_id,client_id),
      CHECK((legacy_removed=1 AND envelope IS NULL AND client_id IS NULL) OR
        (legacy_removed=0 AND envelope IS NOT NULL AND client_id IS NOT NULL AND json_valid(envelope) AND json_extract(envelope,'$.version')='elytra-dm-e2ee-v1'))
    );
    CREATE TABLE IF NOT EXISTS conversation_reads (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS api_rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messaging_keys (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL UNIQUE, encryption_public_key TEXT NOT NULL, signing_public_key TEXT NOT NULL,
      backup_iv TEXT NOT NULL, backup_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_uploads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL UNIQUE, type TEXT NOT NULL, size INTEGER NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('post','avatar','banner')),
      claimed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER, last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_tokens_user ON agent_tokens(user_id,created_at);
    CREATE INDEX IF NOT EXISTS media_uploads_user ON media_uploads(user_id,created_at);
    CREATE INDEX IF NOT EXISTS posts_time ON posts(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS posts_author_time ON posts(author_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS posts_reply ON posts(reply_to_id, created_at);
    CREATE INDEX IF NOT EXISTS posts_quote ON posts(quote_id, created_at);
    CREATE INDEX IF NOT EXISTS likes_post ON likes(post_id);
    CREATE INDEX IF NOT EXISTS reposts_post ON reposts(post_id);
    CREATE INDEX IF NOT EXISTS bookmarks_post ON bookmarks(post_id);
    CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);
    CREATE INDEX IF NOT EXISTS hashtags_tag ON hashtags(tag);
    CREATE INDEX IF NOT EXISTS mentions_user ON mentions(user_id);
    CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS timeline_snapshots_expiry ON timeline_snapshots(created_at);
    CREATE INDEX IF NOT EXISTS impressions_post ON impressions(post_id);
    CREATE INDEX IF NOT EXISTS impressions_viewer_time ON impressions(user_id, last_seen_at);
    CREATE INDEX IF NOT EXISTS negative_feedback_author ON negative_feedback(user_id, author_id, created_at);
    CREATE INDEX IF NOT EXISTS negative_feedback_post ON negative_feedback(post_id);
    CREATE INDEX IF NOT EXISTS blocks_target ON blocks(target_id,user_id);
    CREATE INDEX IF NOT EXISTS conversations_a_time ON conversations(user_a,updated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS conversations_b_time ON conversations(user_b,updated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id,seq DESC);
    CREATE INDEX IF NOT EXISTS api_rate_limits_expiry ON api_rate_limits(reset_at);
  `);
  // Existing databases predate the column. Grant the badge to @crystl once, when it is added.
  if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === "verified")) {
    db.exec("ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET verified=1 WHERE username_lower='crystl'").run();
  }
  // ai_operated is the account's own declaration. ai_operated_override is set only by an operator
  // (scripts/set-ai-label.ts) and wins over it: NULL means no override, 1 forces the label on, 0 forces it off.
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userColumns.includes("ai_operated")) db.exec("ALTER TABLE users ADD COLUMN ai_operated INTEGER NOT NULL DEFAULT 0");
  if (!userColumns.includes("ai_operated_override")) db.exec("ALTER TABLE users ADD COLUMN ai_operated_override INTEGER CHECK(ai_operated_override IN (0,1))");
}
export function getDb(): DatabaseSync {
  if (globalDb.elytraDb && configured.has(globalDb.elytraDb)) return globalDb.elytraDb;
  const path = process.env.ELYTRA_DB_PATH || resolve(process.cwd(), "data/elytra.db");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = globalDb.elytraDb || new DatabaseSync(path);
  try {
    initializeDatabase(db);
    migrateMessageStorage(db);
    migrateBackend(db);
    if (process.env.ELYTRA_SEED_DEMO !== "false" && !db.prepare("SELECT id FROM users LIMIT 1").get()) seedDatabase(db);
    globalDb.elytraDb = db;
    configured.add(db);
    return db;
  } catch (error) { if (globalDb.elytraDb === db) globalDb.elytraDb = undefined; db.close(); throw error; }
}
type Statement = ReturnType<DatabaseSync["prepare"]>;
const statements = new WeakMap<DatabaseSync, Map<string, Statement>>();
export function statement(sql: string): Statement {
  const db = getDb();
  let cache = statements.get(db);
  if (!cache) { cache = new Map(); statements.set(db, cache); }
  let prepared = cache.get(sql);
  if (prepared) cache.delete(sql);
  else prepared = db.prepare(sql);
  const max = backendConfig().statementCacheSize;
  if (max > 0) {
    cache.set(sql, prepared);
    if (cache.size > max) cache.delete(cache.keys().next().value!);
  }
  return prepared;
}
export function statementCacheEntries(): number { return statements.get(getDb())?.size ?? 0; }

const depths = new WeakMap<DatabaseSync, number>();
export function transaction<T>(fn: () => T): T {
  const db = getDb(), depth = depths.get(db) ?? 0;
  const savepoint = `elytra_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  depths.set(db, depth + 1);
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Database transactions must be synchronous");
    db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
    throw error;
  } finally { depths.set(db, depth); }
}

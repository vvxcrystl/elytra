import type { DatabaseSync } from "node:sqlite";

/** No server-held encryption key can retroactively turn plaintext into E2EE. */
export function migrateMessageStorage(db: DatabaseSync): void {
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS privacy_migrations(id TEXT PRIMARY KEY, pending INTEGER NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(messages)").all();
  if (columns.some(c => c.name === "content")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE messages_encrypted (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT, envelope TEXT, legacy_removed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, UNIQUE(conversation_id,sender_id,client_id),
          CHECK((legacy_removed=1 AND envelope IS NULL AND client_id IS NULL) OR
            (legacy_removed=0 AND envelope IS NOT NULL AND client_id IS NOT NULL AND json_valid(envelope) AND json_extract(envelope,'$.version')='elytra-dm-e2ee-v1'))
        );
        INSERT INTO messages_encrypted(seq,id,conversation_id,sender_id,legacy_removed,created_at)
          SELECT seq,id,conversation_id,sender_id,1,created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_encrypted RENAME TO messages;
        CREATE INDEX messages_conversation_seq ON messages(conversation_id,seq DESC);
        INSERT OR REPLACE INTO privacy_migrations VALUES('ciphertext_only_messages',1);
        COMMIT;
      `);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (db.prepare("SELECT 1 FROM privacy_migrations WHERE id='ciphertext_only_messages' AND pending=1").get()) {
    // A busy checkpoint fails closed; retain pending=1 and retry on the next start.
    const checkpoint = () => {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (row?.busy) throw new Error("Message privacy migration requires database readers to finish; retry startup");
    };
    checkpoint();
    db.exec("VACUUM");
    checkpoint();
    db.prepare("UPDATE privacy_migrations SET pending=0 WHERE id='ciphertext_only_messages'").run();
    checkpoint();
  }
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { generateIdentity, recoverIdentity, encryptText, decryptText, safetyNumber, toBase64, fromBase64 } from "../src/lib/e2ee";
import { DM_PROTOCOL, envelopeBytes, type IdentityBackup, type EncryptedEnvelope } from "../src/lib/e2ee-contract";
import { getDb } from "../src/server/db";
import { createUser, one } from "../src/server/data/core";
import { registerMessagingIdentity, messagingBackup } from "../src/server/data/encryption";
import { createConversation, sendMessage, messagesFor } from "../src/server/data/messages";

process.env.ELYTRA_DB_PATH = ":memory:";
const db = getDb(), directory = await mkdtemp(join(tmpdir(), "elytra-e2ee-"));
const cache = globalThis as typeof globalThis & { elytraDb?: DatabaseSync };
let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
function changed(value: string): string { const bytes = fromBase64(value); bytes[0] ^= 1; return toBase64(bytes); }
try {
  const alice = createUser("crypto_alice", "Alice", "password123"), bob = createUser("crypto_bob", "Bob", "password123"), eve = createUser("crypto_eve", "Eve", "password123");
  const [a, b, e] = await Promise.all([generateIdentity(alice.id), generateIdentity(bob.id), generateIdentity(eve.id)]);
  registerMessagingIdentity(alice.id, a.registration); registerMessagingIdentity(bob.id, b.registration); registerMessagingIdentity(eve.id, e.registration);
  const conversation = createConversation(alice.id, bob.id).conversation;
  const context = { conversationId: conversation.id, senderId: alice.id, recipientId: bob.id };
  const text = "confidential message – 🔐: never store this plaintext";
  const envelope = await encryptText(a.identity, b.identity, context, text);
  await check("only sender and recipient decrypt; keys cannot be exported and equal text encrypts differently", async () => {
    assert.equal(await decryptText(a.identity, a.identity, context, envelope), text);
    assert.equal(await decryptText(b.identity, a.identity, context, envelope), text);
    await assert.rejects(decryptText(e.identity, a.identity, context, envelope));
    await assert.rejects(crypto.subtle.exportKey("pkcs8", a.identity.encryptionPrivateKey));
    await assert.rejects(crypto.subtle.exportKey("pkcs8", a.identity.signingPrivateKey));
    const second = await encryptText(a.identity, b.identity, context, text);
    assert.notEqual(second.recipientCiphertext, envelope.recipientCiphertext); assert.notEqual(second.ephemeralPublicKey, envelope.ephemeralPublicKey);
    assert.equal(await safetyNumber(a.identity, b.identity), await safetyNumber(b.identity, a.identity));
  });
  await check("altered ciphertext, nonce, signature, participant, conversation, and sender identity fail authentication", async () => {
    for (const key of ["recipientCiphertext", "senderCiphertext", "recipientIv", "salt", "signature"] as const) {
      const modified = { ...envelope, [key]: changed(envelope[key]) };
      await assert.rejects(decryptText(b.identity, a.identity, context, modified));
      assert.throws(() => sendMessage(alice.id, conversation.id, modified));
    }
    await assert.rejects(decryptText(b.identity, a.identity, { ...context, conversationId: "other-chat" }, envelope));
    await assert.rejects(decryptText(b.identity, a.identity, { ...context, senderId: eve.id }, envelope));
    await assert.rejects(decryptText(b.identity, e.identity, context, envelope));
    assert.throws(() => sendMessage(eve.id, conversation.id, envelope));
  });
  await check("signed ciphertext only in storage; retry deduplication, conflicts, and server key validation", async () => {
    const sent = sendMessage(alice.id, conversation.id, envelope);
    assert.equal(sendMessage(alice.id, conversation.id, { ...envelope }).id, sent.id);
    assert.equal(sendMessage(alice.id, conversation.id, Object.fromEntries(Object.entries(envelope).reverse()) as EncryptedEnvelope).id, sent.id);
    const row = one<{ envelope: string }>("SELECT envelope FROM messages WHERE id=?", sent.id)!;
    assert(!row.envelope.includes(text)); assert(!JSON.stringify(sent).includes(text)); assert(!Object.hasOwn(sent, "content"));
    assert(db.prepare("PRAGMA table_info(messages)").all().every(column => column.name !== "content"));
    assert.throws(() => sendMessage(alice.id, conversation.id, { ...envelope, content: text } as EncryptedEnvelope));
    assert.throws(() => sendMessage(alice.id, conversation.id, text as unknown as EncryptedEnvelope));
    const conflict = await encryptText(a.identity, b.identity, context, "different body");
    // First reject invalid signatures, then a valid signature on a conflicting retry.
    assert.throws(() => sendMessage(alice.id, conversation.id, { ...conflict, clientId: envelope.clientId }));
    conflict.clientId = envelope.clientId;
    conflict.signature = toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.identity.signingPrivateKey, envelopeBytes(context, conflict))));
    assert.throws(() => sendMessage(alice.id, conversation.id, conflict), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.throws(() => registerMessagingIdentity(alice.id, { ...a.registration, backupCiphertext: changed(a.registration.backupCiphertext) }));
    assert.throws(() => registerMessagingIdentity(alice.id, e.registration));
    const unready = createUser("crypto_unready", "Unready", "password123");
    const chat = createConversation(alice.id, unready.id).conversation;
    assert.throws(() => sendMessage(alice.id, chat.id, envelope));
  });
  await check("recovery is local; wrong code, modified backup, or another account cannot restore keys", async () => {
    const backup = messagingBackup(alice.id)!;
    assert(!JSON.stringify(backup).includes(a.recoveryCode));
    const recovered = await recoverIdentity(backup, a.recoveryCode);
    assert.equal(recovered.keyId, a.identity.keyId); assert.equal(await decryptText(recovered, a.identity, context, envelope), text);
    await assert.rejects(recoverIdentity(backup, b.recoveryCode));
    await assert.rejects(recoverIdentity({ ...backup, backupCiphertext: changed(backup.backupCiphertext) }, a.recoveryCode));
    await assert.rejects(recoverIdentity({ ...backup, userId: bob.id } as IdentityBackup, a.recoveryCode));
    assert.equal(a.recoveryCode.length, 43);
    assert.equal((one<{ n: number }>("SELECT COUNT(*) AS n FROM messaging_keys")!).n, 3);
  });
  await check("10,000 Unicode characters fit the ciphertext format and oversized/empty text is refused", async () => {
    const large = await encryptText(a.identity, b.identity, context, "😀".repeat(10000));
    assert.equal(fromBase64(large.recipientCiphertext).length, 40016);
    sendMessage(alice.id, conversation.id, large);
    assert.equal(await decryptText(b.identity, a.identity, context, large), "😀".repeat(10000));
    await assert.rejects(encryptText(a.identity, b.identity, context, "x".repeat(10001)));
    await assert.rejects(encryptText(a.identity, b.identity, context, " "));
  });
  await check("legacy migration removes bodies from live DB and WAL, keeps IDs/read markers, and survives reconnect", async () => {
    const path = join(directory, "legacy.db"); db.prepare("VACUUM INTO ?").run(path);
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=OFF; DROP TABLE messages;
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,conversation_id TEXT NOT NULL,sender_id TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    const mainMarker = "LEGACY-PRIVATE-MAIN-UNIQUE-1".repeat(100), walMarker = "LEGACY-PRIVATE-WAL-UNIQUE-2".repeat(100);
    legacy.prepare("INSERT INTO messages VALUES(1,?,?,?,?,?)").run("old_main", conversation.id, alice.id, mainMarker, 1);
    legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert((await readFile(path)).includes(Buffer.from(mainMarker)));
    legacy.prepare("INSERT INTO messages VALUES(2,?,?,?,?,?)").run("old_wal", conversation.id, bob.id, walMarker, 2);
    assert((await readFile(`${path}-wal`)).includes(Buffer.from(walMarker)));
    legacy.prepare("INSERT OR REPLACE INTO conversation_reads VALUES(?,?,?)").run(conversation.id, bob.id, 1);
    cache.elytraDb = legacy; process.env.ELYTRA_DB_PATH = path;
    const migrated = getDb();
    assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 2);
    assert(migrated.prepare("PRAGMA table_info(messages)").all().every(column => column.name !== "content"));
    const messages = messagesFor(bob.id, conversation.id, { cursor: null, limit: 20 }).items;
    assert(messages.every(m => m.legacyRemoved && m.encryption === null && !Object.hasOwn(m, "content")));
    assert.equal(migrated.prepare("SELECT last_read_seq FROM conversation_reads WHERE conversation_id=? AND user_id=?").get(conversation.id, bob.id)!.last_read_seq, 1);
    for (const suffix of ["", "-wal", "-journal"]) {
      const bytes = await readFile(`${path}${suffix}`).catch(() => Buffer.alloc(0));
      assert(!bytes.includes(Buffer.from(mainMarker)), `Plaintext remained in ${suffix || "database"}`); assert(!bytes.includes(Buffer.from(walMarker)), `Plaintext remained in ${suffix || "database"}`);
    }
    assert.equal(migrated.prepare("SELECT pending FROM privacy_migrations WHERE id='ciphertext_only_messages'").get()!.pending, 0);
    migrated.close(); cache.elytraDb = undefined;
    const reopened = getDb(); assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 2);
    const newMessage = sendMessage(alice.id, conversation.id, await encryptText(a.identity, b.identity, context, "after migration"));
    assert.equal(newMessage.encryption?.version, DM_PROTOCOL); assert(Number(reopened.prepare("SELECT seq FROM messages WHERE id=?").get(newMessage.id)!.seq) > 2);
    reopened.close(); cache.elytraDb = db; process.env.ELYTRA_DB_PATH = ":memory:";
  });
  await check("busy legacy WAL cleanup fails closed and retries after the reader releases its snapshot", async () => {
    const path = join(directory, "busy-legacy.db"); db.prepare("VACUUM INTO ?").run(path);
    const writer = new DatabaseSync(path);
    writer.exec(`PRAGMA journal_mode=WAL; DROP TABLE messages;
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,conversation_id TEXT,sender_id TEXT,content TEXT,created_at INTEGER);`);
    const marker = "LEGACY-BUSY-READER-PRIVATE-MARKER".repeat(100);
    writer.prepare("INSERT INTO messages VALUES(1,?,?,?,?,?)").run("busy_old", conversation.id, alice.id, marker, 1);
    const reader = new DatabaseSync(path); reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM messages").get();
    cache.elytraDb = writer; process.env.ELYTRA_DB_PATH = path;
    try { assert.throws(() => getDb(), /Message privacy migration requires database readers to finish/); assert.equal(cache.elytraDb, undefined); }
    finally { reader.exec("COMMIT"); reader.close(); }
    const retried = getDb();
    assert.equal(retried.prepare("SELECT pending FROM privacy_migrations WHERE id='ciphertext_only_messages'").get()!.pending, 0);
    assert.equal(retried.prepare("SELECT legacy_removed FROM messages WHERE id='busy_old'").get()!.legacy_removed, 1);
    for (const suffix of ["", "-wal"]) assert(!(await readFile(`${path}${suffix}`).catch(() => Buffer.alloc(0))).includes(Buffer.from(marker)));
    retried.close(); cache.elytraDb = db; process.env.ELYTRA_DB_PATH = ":memory:";
  });
  console.log(`E2EE checks passed: ${checks} groups; real browser-compatible cryptography, no plaintext server storage.`);
} finally { cache.elytraDb = db; db.close(); await rm(directory, { recursive: true, force: true }); }

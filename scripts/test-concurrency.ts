import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Capacity, sharedCapacity } from "../src/server/concurrency";
import { getDb, statement, statementCacheEntries, transaction } from "../src/server/db";
import { maintainDatabase } from "../src/server/db-maintenance";
import { migrateBackend } from "../src/server/db-migrations";
import { one, run, createUser, createSession, viewerForToken } from "../src/server/data/core";
import { authenticate } from "../src/server/data/core";
import { insertPost, postById, removePost, togglePostInteraction } from "../src/server/data/posts";
import { timeline } from "../src/server/data/timeline";
import { handleApi, requestCapacity } from "../src/server/api/router";
import { boundedBytes } from "../src/server/api/http";
import { rateLimit, clientKey } from "../src/server/rate-limit";
import { serveMedia } from "../src/server/media-response";
import { passwordCapacity } from "../src/server/security";

const directory = await mkdtemp(join(tmpdir(), "elytra-concurrency-"));
Object.assign(process.env, {
  ELYTRA_DB_PATH: join(directory, "test.db"), ELYTRA_UPLOAD_DIR: directory, ELYTRA_SEED_DEMO: "false",
  ELYTRA_API_CONCURRENCY: "4", ELYTRA_UPLOAD_CONCURRENCY: "2", ELYTRA_BODY_TIMEOUT_MS: "80",
  ELYTRA_PASSWORD_CONCURRENCY: "2", ELYTRA_PASSWORD_QUEUE: "4", ELYTRA_PASSWORD_WAIT_MS: "2000",
  ELYTRA_STATEMENT_CACHE_SIZE: "32", ELYTRA_SNAPSHOTS_PER_VIEWER: "3", ELYTRA_SNAPSHOT_ENTRIES: "100", ELYTRA_DB_BUSY_TIMEOUT_MS: "20",
});
const db = getDb();
let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
const isOverloaded = (error: unknown) => (error as { code?: string }).code === "overloaded";
const alice = await createUser("load_alice", "Alice", "password123"), bob = await createUser("load_bob", "Bob", "password123");
const token = createSession(alice.id).token;
const api = (path: string, init: RequestInit = {}) => handleApi(new Request(`http://localhost/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } }));
try {
  await check("bounded FIFO capacity, immediate shedding, deadlines, and exactly-once release", async () => {
    const gate = new Capacity(1, 1, 15), release = await gate.acquire();
    const pending = gate.acquire();
    await assert.rejects(gate.acquire(), isOverloaded);
    release(); release();
    const next = await pending;
    assert.deepEqual(gate.snapshot(), { active: 1, queued: 0, limit: 1 });
    await assert.rejects(gate.acquire(), isOverloaded);
    assert.equal(gate.snapshot().queued, 0);
    next();
    await assert.rejects(gate.run(async () => { throw new Error("failed task"); }), /failed task/);
    assert.equal(gate.snapshot().active, 0);
  });
  await check("concurrent password work leaves the event loop responsive and cannot overflow its queue", async () => {
    const releases = await Promise.all([passwordCapacity().acquire(), passwordCapacity().acquire()]);
    const work = Array.from({ length: 4 }, () => authenticate("load_alice", "password123"));
    assert.equal(passwordCapacity().snapshot().queued, 4);
    await assert.rejects(authenticate("load_alice", "password123"), isOverloaded);
    releases.forEach(release => release());
    let ticked = false;
    const timer = delay(0).then(() => { ticked = true; });
    assert((await work[0])?.id === alice.id);
    assert(ticked, "a timer must run while scrypt is pending");
    assert((await Promise.all(work)).every(user => user?.id === alice.id));
    await timer;
    assert.equal(passwordCapacity().snapshot().active, 0);
  });
  await check("simultaneous registrations resolve uniqueness at commit and return a stable 409", async () => {
    const register = () => api("/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "load_race", displayName: "Race", password: "password123" }) });
    const results = await Promise.all([register(), register()]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE username_lower='load_race'")!.n, 1);
  });
  await check("API saturation sheds requests with Retry-After while health and HEAD still work", async () => {
    const releases = await Promise.all(Array.from({ length: 4 }, () => requestCapacity().acquire()));
    const overloaded = await api("/users/me");
    assert.equal(overloaded.status, 503); assert.equal(overloaded.headers.get("Retry-After"), "1");
    assert.equal((await api("/health")).status, 200);
    assert.equal((await api("/health/live", { headers: { Authorization: "bad" } })).status, 200);
    assert.equal(await (await api("/health", { method: "HEAD" })).text(), "");
    releases.forEach(release => release());
    assert.equal((await api("/users/me")).status, 200);
  });
  await check("stalled, cancelled, and oversized request bodies release readers and API slots", async () => {
    let cancelled = 0;
    const stream = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const slow = stream();
    const res = await api("/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: slow, ...{ duplex: "half" } });
    assert.equal(res.status, 408); assert.equal(cancelled, 1); assert.equal(slow.locked, false);
    assert.equal(requestCapacity().snapshot().active, 0);
    const abort = new AbortController(), body = stream();
    const pending = boundedBytes(new Request("http://localhost", { method: "POST", body, signal: abort.signal, ...{ duplex: "half" } }), 100);
    abort.abort();
    await assert.rejects(pending, (error: unknown) => (error as { code: string }).code === "request_aborted");
    assert.equal(body.locked, false);
    const alreadyAborted = stream();
    await assert.rejects(boundedBytes(new Request("http://localhost", { method: "POST", body: alreadyAborted, signal: abort.signal, ...{ duplex: "half" } }), 100), (error: unknown) => (error as { code: string }).code === "request_aborted");
    assert.equal(alreadyAborted.locked, false);
    let sent = 0;
    const tiny = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 1000) controller.enqueue(new Uint8Array([42])); else controller.close(); } });
    const bytes = await boundedBytes(new Request("http://localhost", { method: "POST", body: tiny, ...{ duplex: "half" } }), 2000);
    assert.equal(bytes.length, 1000); assert(bytes.every(b => b === 42));
    await assert.rejects(boundedBytes(new Request("http://localhost", { method: "POST", body: "123456" }), 5), (error: unknown) => (error as { status: number }).status === 413);
  });
  await check("upload capacity is reserved before multipart buffering and released after timeout", async () => {
    const slow = () => api("/media", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" }, body: new ReadableStream(), ...{ duplex: "half" } });
    const pending = [slow(), slow()];
    await delay(0);
    assert.equal((await slow()).status, 503);
    assert((await Promise.all(pending)).every(r => r.status === 408));
    assert.equal(requestCapacity().snapshot().active, 0);
  });
  await check("rate limits reset atomically and clients share buckets only when proxy identity is unavailable", () => {
    assert.equal(rateLimit("test-window", 2, 60000).remaining, 1);
    assert.equal(rateLimit("test-window", 2, 60000).remaining, 0);
    assert.throws(() => rateLimit("test-window", 2, 60000), (error: unknown) => (error as { status: number }).status === 429);
    run("UPDATE api_rate_limits SET reset_at=0");
    assert.equal(rateLimit("test-window", 2, 60000).remaining, 1);
    assert.equal(clientKey(new Headers({ "x-forwarded-for": "203.0.113.1" })), "untrusted");
    process.env.ELYTRA_TRUSTED_IP_HEADER = "x-real-ip";
    assert.notEqual(clientKey(new Headers({ "x-real-ip": "203.0.113.1" })), clientKey(new Headers({ "x-real-ip": "203.0.113.2" })));
    assert.equal(clientKey(new Headers({ "x-real-ip": "nonsense" })), "untrusted");
    delete process.env.ELYTRA_TRUSTED_IP_HEADER;
  });
  const post = insertPost(bob.id, { content: "Popular post" });
  await check("engagement counters survive idempotent concurrent writes, rollbacks, deletes, and backfill", async () => {
    const writes = await Promise.all(Array.from({ length: 4 }, () => api(`/posts/${post}/like`, { method: "PUT" })));
    assert(writes.every(r => r.status === 200)); assert.equal(postById(post, alice.id)!.likeCount, 1);
    const reply = insertPost(alice.id, { content: "reply", replyToId: post });
    assert.equal(postById(post, null)!.replyCount, 1);
    assert.throws(() => transaction(() => { togglePostInteraction(bob.id, post, "bookmark"); throw new Error("rollback"); }), /rollback/);
    assert.equal(postById(post, null)!.bookmarkCount, 0);
    removePost(alice.id, reply); assert.equal(postById(post, null)!.replyCount, 0);
    run("UPDATE post_stats SET likes=99 WHERE post_id=?", post);
    run("DELETE FROM backend_migrations WHERE id='post_stats_v1'");
    migrateBackend(db); migrateBackend(db);
    assert.equal(postById(post, null)!.likeCount, 1);
    run("DELETE FROM users WHERE id=?", alice.id);
    assert.equal(postById(post, null)!.likeCount, 0);
  });
  await check("feed snapshots and retained prepared statements stay bounded; expiry applies before cleanup", () => {
    transaction(() => { for (let i = 0; i < 180; i++) insertPost(bob.id, { content: `bounded ${i}` }); });
    const source = { kind: "user", username: "load_bob", tab: "posts" } as const;
    let page = timeline(source, null, bob.id, { limit: 20 });
    const cursor = page.nextCursor!;
    const [snapshotId] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    assert.equal(JSON.parse(one<{ entries: string }>("SELECT entries FROM timeline_snapshots WHERE id=?", snapshotId)!.entries).length, 100);
    const ids = page.items.map(i => i.key);
    while (page.nextCursor) { page = timeline(source, page.nextCursor, bob.id); ids.push(...page.items.map(i => i.key)); }
    assert.equal(ids.length, 100); assert.equal(new Set(ids).size, 100);
    run("UPDATE timeline_snapshots SET created_at=0 WHERE id=?", snapshotId);
    assert.throws(() => timeline(source, cursor, bob.id, { strictCursor: true }), (error: unknown) => (error as { code: string }).code === "invalid_cursor");
    const repeated = timeline(source, null, bob.id);
    const before = one<{ n: number }>("SELECT COUNT(*) n FROM timeline_snapshots WHERE viewer_id=?", bob.id)!.n;
    timeline(source, null, bob.id);
    assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM timeline_snapshots WHERE viewer_id=?", bob.id)!.n, before);
    for (let i = 0; i < 4; i++) timeline({ kind: "search", q: `bounded ${i}`, tab: "latest" }, null, bob.id);
    assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM timeline_snapshots WHERE viewer_id=?", bob.id)!.n, 3);
    assert.throws(() => timeline(source, repeated.nextCursor, bob.id, { strictCursor: true }), (error: unknown) => (error as { code: string }).code === "invalid_cursor");
    const first = statement("SELECT 42 AS answer");
    assert.equal(first, statement("SELECT 42 AS answer"));
    for (let i = 0; i < 100; i++) statement(`SELECT ${i} AS answer`).get();
    assert.equal(statementCacheEntries(), 32);
    const session = createSession(bob.id);
    run("UPDATE sessions SET expires_at=0 WHERE user_id=?", bob.id);
    assert.equal(viewerForToken(session.token), null);
  });
  await check("maintenance removes bounded batches and skips repeated sweeps within its interval", () => {
    const maintenance = new DatabaseSync(":memory:");
    try {
      maintenance.exec("CREATE TABLE sessions(expires_at INTEGER); CREATE TABLE agent_tokens(expires_at INTEGER); CREATE TABLE api_rate_limits(reset_at INTEGER); CREATE TABLE timeline_snapshots(created_at INTEGER)");
      const insert = maintenance.prepare("INSERT INTO api_rate_limits VALUES(0)");
      for (let i = 0; i < 1200; i++) insert.run();
      maintainDatabase(maintenance, 100000000);
      assert.equal(maintenance.prepare("SELECT COUNT(*) n FROM api_rate_limits").get()!.n, 700);
      maintainDatabase(maintenance, 100000000);
      assert.equal(maintenance.prepare("SELECT COUNT(*) n FROM api_rate_limits").get()!.n, 700);
      maintainDatabase(maintenance, 100060000);
      assert.equal(maintenance.prepare("SELECT COUNT(*) n FROM api_rate_limits").get()!.n, 200);
    } finally { maintenance.close(); }
  });
  await check("competing WAL writers return retryable 503s while existing feed pages remain readable", async () => {
    const source = { kind: "user", username: "load_bob", tab: "posts" } as const;
    const cursor = timeline(source, null, bob.id).nextCursor!;
    const writer = new DatabaseSync(process.env.ELYTRA_DB_PATH!);
    try {
      writer.exec("BEGIN IMMEDIATE");
      assert.equal(timeline(source, cursor, bob.id).items.length, 20);
      const response = await handleApi(new Request("http://localhost/api/v1/users"));
      assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "1");
      assert.equal((await api("/health")).status, 200);
    } finally { writer.exec("ROLLBACK"); writer.close(); }
    assert.equal((await handleApi(new Request("http://localhost/api/v1/users"))).status, 200);
  });
  await check("media streams match disk bytes, support HEAD/ETag, and release descriptors on cancellation", async () => {
    const name = "stream-fixture.png", bytes = Buffer.alloc(256 * 1024, 42);
    await writeFile(join(directory, name), bytes);
    const response = await serveMedia(new Request("http://localhost"), name);
    assert.equal(response.headers.get("Content-Length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const head = await serveMedia(new Request("http://localhost", { method: "HEAD" }), name);
    assert.equal(await head.text(), "");
    const cached = await serveMedia(new Request("http://localhost", { headers: { "If-None-Match": head.headers.get("ETag")! } }), name);
    assert.equal(cached.status, 304);
    const aborted = await serveMedia(new Request("http://localhost"), name);
    await aborted.body!.cancel();
    assert.equal((await serveMedia(new Request("http://localhost"), "../invalid.png")).status, 404);
    assert.equal((await serveMedia(new Request("http://localhost"), "missing.png")).status, 404);
    const held = await serveMedia(new Request("http://localhost"), name);
    await delay(15);
    assert.equal(sharedCapacity("media", 64).snapshot().active, 1, "an unread stream must apply backpressure instead of buffering the file to completion");
    await held.body!.cancel();
    // Repetition catches leaked media capacity on HEAD and conditional responses.
    for (let i = 0; i < 70; i++) assert.equal((await serveMedia(new Request("http://localhost", { method: "HEAD" }), name)).status, 200);
  });
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(`Concurrency checks passed: ${checks} groups; isolated file-backed WAL database.`);

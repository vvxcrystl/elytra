import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleApi } from "../src/server/api/router";
import { endpoints } from "../src/server/api/endpoints";
import { openApiDocument, schemas } from "../src/server/api/openapi";
import { getDb } from "../src/server/db";
import { one, run, createSession } from "../src/server/data/core";
import { postById } from "../src/server/data/posts";
import type { Message } from "../src/lib/api-types";
import { generateIdentity, encryptText, decryptText, type ClientIdentity } from "../src/lib/e2ee";

process.env.ELYTRA_DB_PATH = ":memory:";
const directory = await mkdtemp(join(tmpdir(), "elytra-api-"));
process.env.ELYTRA_UPLOAD_DIR = join(directory, "uploads");
const db = getDb();
let checks = 0;
const covered = new Set<string>();
const identities = new Map<string, ClientIdentity>();
type Json = Record<string, unknown>;
function validateSchema(value: unknown, schema: Json, location = "response") {
  if (schema.$ref) return validateSchema(value, schemas[String(schema.$ref).split("/").at(-1)!], location);
  if (schema.anyOf) {
    assert((schema.anyOf as Json[]).some(s => { try { validateSchema(value, s, location); return true; } catch { return false; } }), `${location} does not match schema`); return;
  }
  if (schema.type === "null") { assert.equal(value, null, location); return; }
  if (schema.type === "integer") { assert(Number.isSafeInteger(value), location); assert(Number(value) >= Number(schema.minimum ?? -Infinity)); return; }
  if (schema.type === "array") { assert(Array.isArray(value), location); for (const item of value) validateSchema(item, schema.items as Json, location); return; }
  if (schema.type === "object") {
    assert(value && typeof value === "object" && !Array.isArray(value), location);
    const input = value as Json, properties = schema.properties as Record<string, Json>;
    for (const name of (schema.required as string[] ?? [])) assert(Object.hasOwn(input, name), `${location}.${name} missing`);
    for (const [name, item] of Object.entries(input)) { if (properties[name]) validateSchema(item, properties[name], `${location}.${name}`); else assert(schema.additionalProperties !== false, `${location}.${name} unexpected`); } return;
  }
  if (schema.type) assert.equal(typeof value, schema.type, location);
  if (schema.enum) assert((schema.enum as unknown[]).includes(value), location);
  if (schema.const) assert.equal(value, schema.const, location);
  if (schema.format === "date-time") assert.equal(new Date(String(value)).toISOString(), value, location);
}
async function request(method: string, path: string, options: { token?: string; cookie?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; status?: number } = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("Cookie", `elytra_session=${options.cookie}`);
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  const res = await handleApi(new Request(`http://localhost/api/v1${path}`, { method, headers, body: options.json !== undefined ? JSON.stringify(options.json) : options.body }));
  assert.equal(res.status, options.status ?? 200, `${method} ${path}: ${await res.clone().text()}`);
  assert.equal(res.headers.get("cache-control"), "no-store"); assert(res.headers.get("x-request-id"));
  const result = res.status === 204 || method === "HEAD" ? {} : await res.json();
  if (res.ok) {
    const endpoint = endpoints.find(e => e.method === method && new RegExp(`^${e.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(path.split("?")[0]));
    if (endpoint) { covered.add(`${endpoint.method} ${endpoint.path}`); validateSchema(result.data, endpoint.paged ? { type: "array", items: schemas[endpoint.response] } : schemas[endpoint.response]); if (endpoint.paged) assert(typeof result.meta.nextCursor === "string" || result.meta.nextCursor === null); }
  } else validateSchema(result, schemas.Error);
  return { res, result, data: result.data };
}
async function encryptedBody(senderId: string, recipientId: string, conversationId: string, content: string) { return { encryption: await encryptText(identities.get(senderId)!, identities.get(recipientId)!, {senderId, recipientId, conversationId}, content) }; }
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
try {
  let aliceId = "", bobId = "", carolId = "", alice = "", bob = "", carol = "";
  await check("registration, cookies, bearer authentication, reservations, and response schemas", async () => {
    for (const name of ["alice", "bob", "carol"]) {
      const value = await request("POST", "/auth/register", { json: { username: `api_${name}`, displayName: name, password: "securepass123" }, status: 201 });
      assert(value.res.headers.get("set-cookie")?.includes("HttpOnly; SameSite=Lax"));
      const { accessToken, user } = value.data; assert(!JSON.stringify(user).includes("password")); assert(!one("SELECT 1 FROM sessions WHERE token_hash=?", accessToken));
      const generated = await generateIdentity(user.id); identities.set(user.id, generated.identity);
      assert.equal((await request("GET", "/users/me/encryption-backup", { token: accessToken })).data, null);
      await request("PUT", "/users/me/encryption-keys", { token: accessToken, json: generated.registration });
      await request("GET", `/users/${user.id}/encryption-keys`, { token: accessToken });
      const backup = await request("GET", "/users/me/encryption-backup", { token: accessToken }); assert(!JSON.stringify(backup.data).includes(generated.recoveryCode));
      if (name === "alice") { aliceId = user.id; alice = accessToken; } if (name === "bob") { bobId = user.id; bob = accessToken; } if (name === "carol") { carolId = user.id; carol = accessToken; }
    }
    await request("POST", "/auth/register", { json: { username: "API_ALICE", displayName: "other", password: "securepass123" }, status: 409 });
    await request("POST", "/auth/register", { json: { username: "messages", displayName: "bad", password: "securepass123" }, status: 400 });
    const login = await request("POST", "/auth/login", { json: { username: "API_ALICE", password: "securepass123" } }); await request("GET", "/users/me", { cookie: login.data.accessToken });
    await request("POST", "/auth/login", { json: { username: "api_alice", password: "wrong" }, status: 401 });
    await request("GET", "/users/me", { status: 401 });
    await request("GET", "/users/me", { headers: { Authorization: "Bearer invalid" }, cookie: alice, status: 401 });
    const expired = createSession(aliceId); run("UPDATE sessions SET expires_at=0 WHERE user_id=?", aliceId);
    await request("GET", "/users/me", { token: expired.token, status: 401 }); alice = createSession(aliceId).token;
  });
  await check("JSON validation, bounded bodies, CSRF, methods, HEAD, and OPTIONS", async () => {
    await request("POST", "/posts", { token: alice, json: [], status: 400 });
    await request("POST", "/posts", { token: alice, json: { content: "x", authorId: bobId }, status: 400 });
    await request("POST", "/posts", { token: alice, body: '{"content":"x","__proto__":{}}', headers: { "Content-Type": "application/json" }, status: 400 });
    await request("POST", "/posts", { token: alice, body: "{", headers: { "Content-Type": "application/json" }, status: 400 });
    await request("POST", "/posts", { token: alice, body: "{}", headers: { "Content-Type": "text/plain" }, status: 415 });
    await request("POST", "/posts", { token: alice, body: " ".repeat(65537), headers: { "Content-Type": "application/json" }, status: 413 });
    await request("POST", "/posts", { cookie: alice, json: { content: "bad" }, headers: { Origin: "https://evil.example" }, status: 403 });
    await request("POST", "/auth/login", { json: { username: "api_alice", password: "securepass123" }, headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 });
    await request("POST", "/posts", { cookie: alice, json: { content: "same origin" }, headers: { Origin: "http://localhost" }, status: 201 });
    const previousOrigin = process.env.ELYTRA_PUBLIC_ORIGIN;
    process.env.ELYTRA_PUBLIC_ORIGIN = "https://twitter.somedomain.org";
    try {
      await request("POST", "/posts", { cookie: alice, json: { content: "through the tunnel" }, headers: { Origin: "https://twitter.somedomain.org" }, status: 201 });
      await request("POST", "/posts", { cookie: alice, json: { content: "wrong host" }, headers: { Origin: "http://localhost" }, status: 403 });
      await request("POST", "/posts", { cookie: alice, json: { content: "wrong subdomain" }, headers: { Origin: "https://other.somedomain.org" }, status: 403 });
    } finally {
      if (previousOrigin === undefined) delete process.env.ELYTRA_PUBLIC_ORIGIN;
      else process.env.ELYTRA_PUBLIC_ORIGIN = previousOrigin;
    }
    for (const path of ["/users?limit=101", "/users?limit=0", "/users?wat=1", "/users?limit=2&limit=3", "/users/%2f"]) await request("GET", path, { status: 400 });
    await request("GET", "/missing", { status: 404 }); const method = await request("PATCH", "/posts", { status: 405 }); assert(method.res.headers.get("allow")?.includes("POST"));
    await request("HEAD", "/users"); await request("OPTIONS", "/conversations", { status: 204 });
  });
  let root = "", reply = "", quote = "";
  await check("posts, replies, quotes, tags, interactions, and ownership", async () => {
    root = (await request("POST", "/posts", { token: bob, json: { content: "hello @api_alice #ApiTest" }, status: 201 })).data.id;
    reply = (await request("POST", "/posts", { token: alice, json: { content: "reply", replyToId: root }, status: 201 })).data.id;
    quote = (await request("POST", "/posts", { token: alice, json: { quoteId: root }, status: 201 })).data.id;
    await request("POST", "/posts", { token: alice, json: { content: "😀".repeat(280) }, status: 201 });
    await request("POST", "/posts", { token: alice, json: { content: "x".repeat(281) }, status: 400 }); await request("POST", "/posts", { token: alice, json: {}, status: 400 });
    await request("POST", "/posts", { token: alice, json: { replyToId: "missing", content: "reply" }, status: 404 });
    await request("GET", `/posts/${root}`, { token: alice }); assert.equal((await request("GET", `/posts/${reply}/thread`, { token: alice })).data.ancestors[0].id, root);
    assert.equal((await request("GET", `/posts/${root}/replies`, { token: alice })).data[0].id, reply); assert.equal((await request("GET", `/posts/${root}/quotes`, { token: alice })).data[0].id, quote);
    for (const kind of ["like", "repost", "bookmark"]) { await request("PUT", `/posts/${root}/${kind}`, { token: alice }); assert.equal((await request("PUT", `/posts/${root}/${kind}`, { token: alice })).data.count, 1); }
    for (const kind of ["likes", "reposts"]) assert.equal((await request("GET", `/posts/${root}/${kind}`)).data[0].id, aliceId);
    assert((await request("GET", "/bookmarks", { token: alice })).data.some((v: { post: { id: string } }) => v.post.id === root));
    for (const kind of ["like", "repost", "bookmark"]) { await request("DELETE", `/posts/${root}/${kind}`, { token: alice }); assert.equal((await request("DELETE", `/posts/${root}/${kind}`, { token: alice })).data.count, 0); }
    await request("DELETE", `/posts/${root}`, { token: alice, status: 403 });
    for (const tab of ["top", "latest", "media"]) await request("GET", `/posts?q=%23ApiTest&tab=${tab}`); await request("GET", "/posts", { status: 400 });
    await request("POST", "/impressions", { token: alice, json: { postIds: [root, root, "missing"] } }); await request("PUT", `/posts/${root}/not-interested`, { token: alice }); await request("GET", "/trends?limit=5");
  });
  await check("profiles, follows, people pagination, and notification read markers", async () => {
    await request("PATCH", "/users/me", { token: alice, json: { displayName: "Updated Alice", bio: "hello", location: "Regina", website: "example.com" } });
    await request("PATCH", "/users/me", { token: alice, json: { website: "javascript:alert(1)" }, status: 400 }); await request("PATCH", "/users/me", { token: alice, json: {}, status: 400 });
    await request("GET", `/users/${aliceId}`); await request("GET", "/users/by-username/API_ALICE"); await request("GET", "/users/suggestions?limit=4", { token: alice });
    for (const method of ["PUT", "PUT", "DELETE", "DELETE", "PUT"]) await request(method, `/users/${bobId}/follow`, { token: alice });
    for (const direction of ["followers", "following"]) await request("GET", `/users/${bobId}/${direction}`, { token: alice });
    for (const tab of ["posts", "replies", "media", "likes"]) await request("GET", `/users/${bobId}/posts?tab=${tab}`, { token: alice });
    const first = await request("GET", "/users?limit=2&q=api_", { token: alice }); assert(first.result.meta.nextCursor);
    assert.equal((await request("GET", `/users?limit=2&q=api_&cursor=${first.result.meta.nextCursor}`, { token: alice })).data.length, 1);
    await request("GET", `/users?limit=2&q=api_&cursor=${first.result.meta.nextCursor}`, { token: bob, status: 400 });
    const notifications = await request("GET", "/notifications?limit=1", { token: bob }); assert(notifications.result.meta.nextCursor);
    await request("GET", `/notifications?limit=1&cursor=${notifications.result.meta.nextCursor}`, { token: bob }); await request("GET", "/notifications?filter=mentions", { token: alice }); await request("GET", "/notifications/unread-count", { token: bob });
    const id = notifications.data[0].id; await request("PUT", `/notifications/${id}/read`, { token: alice, status: 404 }); await request("PUT", `/notifications/${id}/read`, { token: bob }); await request("PUT", "/notifications/read", { token: bob });
  });
  await check("feed cursors stay stable, enforce viewer/source scope, and expire", async () => {
    for (let i = 0; i < 25; i++) await request("POST", "/posts", { token: bob, json: { content: `pagination ${i}` }, status: 201 });
    const first = await request("GET", "/timeline?tab=following&limit=7", { token: alice }); assert.equal(first.data.length, 7); const cursor = first.result.meta.nextCursor; assert(cursor);
    await request("POST", "/posts", { token: bob, json: { content: "arrived after snapshot" }, status: 201 });
    const next = await request("GET", `/timeline?tab=following&limit=7&cursor=${cursor}`, { token: alice }); assert(!next.data.some((v: { key: string }) => first.data.some((p: { key: string }) => p.key === v.key)));
    await request("GET", `/timeline?tab=following&cursor=${cursor}`, { token: bob, status: 400 }); await request("GET", `/timeline?tab=for-you&cursor=${cursor}`, { token: alice, status: 400 }); await request("GET", "/timeline?cursor=malformed", { token: alice, status: 400 });
    run("UPDATE timeline_snapshots SET created_at=0"); await request("GET", `/timeline?tab=following&cursor=${cursor}`, { token: alice, status: 400 }); await request("GET", "/timeline?tab=for-you", { token: alice });
  });
  await check("media ownership, byte validation, transactional claims, and file cleanup", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=", "base64");
    async function upload(purpose = "post") { const form = new FormData(); form.set("file", new File([bytes], "pixel.png", { type: "image/png" })); form.set("purpose", purpose); return (await request("POST", "/media", { token: alice, body: form, status: 201 })).data; }
    const media = await upload(); await request("GET", `/media/${media.id}`, { token: alice }); await request("GET", `/media/${media.id}`, { token: bob, status: 404 });
    await request("POST", "/posts", { token: bob, json: { mediaIds: [media.id] }, status: 404 }); await request("POST", "/posts", { token: alice, json: { mediaIds: [media.id], replyToId: "missing" }, status: 404 }); assert.equal((await request("GET", `/media/${media.id}`, { token: alice })).data.claimed, false);
    const p = (await request("POST", "/posts", { token: alice, json: { mediaIds: [media.id] }, status: 201 })).data; assert.equal(p.imageUrls[0], media.url);
    await request("POST", "/posts", { token: alice, json: { mediaIds: [media.id] }, status: 409 }); await request("DELETE", `/media/${media.id}`, { token: alice, status: 409 }); await request("DELETE", `/posts/${p.id}`, { token: alice });
    await assert.rejects(access(join(process.env.ELYTRA_UPLOAD_DIR!, media.url.split("/").at(-1)!)));
    const pending = await upload(); await request("DELETE", `/media/${pending.id}`, { token: alice }); const avatar = await upload("avatar"), banner = await upload("banner");
    await request("PATCH", "/users/me", { token: alice, json: { avatarMediaId: avatar.id, bannerMediaId: banner.id } }); await request("PATCH", "/users/me", { token: alice, json: { removeAvatar: true, removeBanner: true } });
    const invalid = new FormData(); invalid.set("file", new File(["bad"], "fake.png", { type: "image/png" })); await request("POST", "/media", { token: alice, body: invalid, status: 400 });
  });
  let conversation = "";
  await check("private conversations, ordered pagination, race-safe read markers, and deletion", async () => {
    conversation = (await request("POST", "/conversations", { token: alice, json: { recipientId: bobId }, status: 201 })).data.id;
    assert.equal((await request("POST", "/conversations", { token: bob, json: { recipientId: aliceId } })).data.id, conversation); await request("POST", "/conversations", { token: alice, json: { recipientId: aliceId }, status: 400 });
    const sent: Message[] = []; for (let i = 0; i < 5; i++) sent.push((await request("POST", `/conversations/${conversation}/messages`, { token: alice, json: await encryptedBody(aliceId, bobId, conversation, `message ${i}`), status: 201 })).data);
    const firstMessage = sent[0].id, lastMessage = sent.at(-1)!.id;
    const wire = sent[0]; assert(!Object.hasOwn(wire, "content"));
    assert.equal(await decryptText(identities.get(bobId)!, identities.get(aliceId)!, {conversationId: conversation, senderId: aliceId, recipientId: bobId}, wire.encryption!), "message 0");
    const stored = one<{envelope:string}>("SELECT envelope FROM messages WHERE id=?", wire.id)!;
    assert(!stored.envelope.includes("message 0"));
    const retry = await request("POST", `/conversations/${conversation}/messages`, {token: alice, json: {encryption: wire.encryption}, status: 201}); assert.equal(retry.data.id, wire.id);
    await request("POST", `/conversations/${conversation}/messages`, {token: alice, json: {content: "plaintext must be rejected"}, status: 400});
    await request("POST", `/conversations/${conversation}/messages`, {token: alice, json: {encryption: {...wire.encryption, content: "plaintext inside envelope"}}, status: 400});
    await request("GET", `/conversations/${conversation}`, { token: carol, status: 404 }); await request("GET", `/conversations/${conversation}/messages`, { token: carol, status: 404 }); await request("POST", `/conversations/${conversation}/messages`, { token: carol, json: await encryptedBody(carolId, aliceId, conversation, "intrusion"), status: 404 }); await request("PUT", `/conversations/${conversation}/read`, { token: carol, json: {}, status: 404 });
    const first = await request("GET", `/conversations/${conversation}/messages?limit=2`, { token: bob }); assert.equal(first.data[0].id, lastMessage); assert.equal((await request("GET", `/conversations/${conversation}/messages?limit=2&cursor=${first.result.meta.nextCursor}`, { token: bob })).data[0].id, sent[2].id);
    assert(sent.every((m, i) => i === 0 || m.createdAt > sent[i - 1].createdAt)); await request("GET", `/conversations/${conversation}/messages?cursor=${first.result.meta.nextCursor}`, { token: alice, status: 400 });
    assert.equal((await request("GET", "/conversations/unread-count", { token: bob })).data.unreadCount, 5); assert.equal((await request("PUT", `/conversations/${conversation}/read`, { token: bob, json: { upToMessageId: firstMessage } })).data.unreadCount, 4);
    await request("PUT", `/conversations/${conversation}/read`, { token: bob, json: { upToMessageId: lastMessage } }); assert.equal((await request("PUT", `/conversations/${conversation}/read`, { token: bob, json: { upToMessageId: firstMessage } })).data.unreadCount, 0);
    await request("POST", `/conversations/${conversation}/messages`, { token: bob, json: await encryptedBody(bobId, aliceId, conversation, "😀".repeat(10000)), status: 201 }); await request("POST", `/conversations/${conversation}/messages`, { token: bob, json: { content: " " }, status: 400 });
    await request("DELETE", `/messages/${firstMessage}`, { token: carol, status: 404 }); await request("DELETE", `/messages/${firstMessage}`, { token: bob, status: 403 }); await request("DELETE", `/messages/${firstMessage}`, { token: alice });
    await request("GET", "/conversations?limit=1", { token: alice }); await request("POST", "/conversations", { token: alice, json: { recipientId: carolId }, status: 201 }); const inbox = await request("GET", "/conversations?limit=1", { token: alice }); assert(inbox.result.meta.nextCursor);
    await request("GET", `/conversations?limit=1&cursor=${inbox.result.meta.nextCursor}`, { token: alice }); await request("GET", `/conversations?limit=1&cursor=${inbox.result.meta.nextCursor}`, { token: bob, status: 400 });
  });
  await check("blocks/mutes apply to the API, shared UI data, and active feed snapshots", async () => {
    const snapshot = await request("GET", "/timeline?tab=following&limit=1", { token: alice }); assert(snapshot.result.meta.nextCursor);
    await request("PUT", `/users/${bobId}/mute`, { token: alice }); await request("PUT", `/users/${bobId}/mute`, { token: alice }); assert.equal((await request("GET", "/users/me/mutes", { token: alice })).data[0].id, bobId);
    const remaining = (await request("GET", `/timeline?tab=following&cursor=${snapshot.result.meta.nextCursor}`, { token: alice })).data; assert(remaining.every((v: { post: { author: { id: string } } }) => v.post.author.id !== bobId));
    await request("GET", `/posts/${root}`, { token: alice }); assert.equal((await request("GET", "/conversations/unread-count", { token: alice })).data.unreadCount, 0); assert(!(await request("GET", "/notifications", { token: alice })).data.some((n: { actor: { id: string } }) => n.actor.id === bobId));
    await request("DELETE", `/users/${bobId}/mute`, { token: alice }); await request("PUT", `/users/${bobId}/block`, { token: alice }); await request("PUT", `/users/${bobId}/block`, { token: alice }); assert.equal((await request("GET", "/users/me/blocks", { token: alice })).data[0].id, bobId);
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM follows WHERE follower_id=? AND followee_id=?", aliceId, bobId)!.n, 0); assert.equal(postById(root, aliceId), null); assert.equal(postById(root, carolId)?.id, root); assert.equal(postById(quote, aliceId)?.quote?.deleted, true);
    await request("GET", `/posts/${root}`, { token: alice, status: 404 }); await request("PUT", `/users/${aliceId}/follow`, { token: bob, status: 403 }); await request("POST", "/posts", { token: bob, json: { replyToId: reply, content: "blocked reply" }, status: 403 }); await request("POST", `/conversations/${conversation}/messages`, { token: bob, json: await encryptedBody(bobId, aliceId, conversation, "blocked message"), status: 403 }); await request("POST", "/conversations", { token: bob, json: { recipientId: aliceId }, status: 403 });
    assert.equal((await request("GET", `/conversations/${conversation}`, { token: bob })).data.blocked, true); await request("GET", `/conversations/${conversation}/messages`, { token: alice }); await request("DELETE", `/users/${bobId}/block`, { token: alice }); assert.equal((await request("GET", `/users/${bobId}`, { token: alice })).data.isBlocked, false); await request("DELETE", `/posts/${root}`, { token: bob }); assert.equal(postById(quote, aliceId)?.quote?.deleted, true);
  });
  await check("OpenAPI covers every operation; logout and global revocation work", async () => {
    await request("GET", "/health"); await request("GET", ""); assert.equal((await request("GET", "/openapi.json")).result.openapi, "3.1.0"); assert.equal(Object.values(openApiDocument().paths).reduce((n, p) => n + Object.keys(p).length, 0), endpoints.length);
    await request("POST", "/auth/logout", { token: alice }); await request("GET", "/users/me", { token: alice, status: 401 }); const session = createSession(aliceId), other = createSession(aliceId); await request("DELETE", "/auth/sessions", { token: session.token }); await request("GET", "/users/me", { token: other.token, status: 401 });
    assert.deepEqual(endpoints.map(e => `${e.method} ${e.path}`).filter(key => !covered.has(key)), [], "Missing successful endpoint coverage");
  });
  await check("persistent login throttling returns 429 and Retry-After", async () => {
    for (let i = 0; i < 10; i++) await request("POST", "/auth/login", { json: { username: "api_carol", password: "wrong" }, status: 401 }); const limited = await request("POST", "/auth/login", { json: { username: "api_carol", password: "wrong" }, status: 429 }); assert(Number(limited.res.headers.get("retry-after")) > 0);
  });
  await check("additive migrations preserve existing data and can run repeatedly", async () => {
    const path = join(directory, "legacy.db"); db.prepare("VACUUM INTO ?").run(path); const old = new DatabaseSync(path); const before = old.prepare("SELECT COUNT(*) AS n FROM users").get()!.n;
    old.exec("DROP TABLE conversation_reads; DROP TABLE messages; DROP TABLE conversations; DROP TABLE blocks; DROP TABLE mutes; DROP TABLE api_rate_limits; DROP TABLE media_uploads"); const cache = globalThis as typeof globalThis & { elytraDb?: DatabaseSync }; cache.elytraDb = old;
    const migrated = getDb(); assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, before); for (const table of ["conversations", "messages", "conversation_reads", "blocks", "mutes", "media_uploads", "api_rate_limits"]) assert(migrated.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)); assert.equal(getDb(), migrated); migrated.close(); cache.elytraDb = db;
  });
  console.log(`API checks passed: ${checks} groups, ${covered.size} operations; isolated database and uploads.`);
} finally { db.close(); await rm(directory, { recursive: true, force: true }); }

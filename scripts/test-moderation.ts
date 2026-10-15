import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SlurMatcher, getSeedMatcher, seedEntries } from "../src/server/moderation/slurs";
import { getSlurMatcher } from "../src/server/moderation/lexicon";
import { normalizeMapped } from "../src/server/moderation/normalize";
import { migrateModerationResults, moderationResultsSchema } from "../src/server/moderation/migration";
import { migrateBackend } from "../src/server/db-migrations";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeText, features, LABELS, type Scores } from "../src/server/moderation/linear";
import { getClassifier } from "../src/server/moderation/classifier";
import { moderationConfig } from "../src/server/moderation/config";
import { classifyGuard, parseGuardOutput, shouldEscalate, guardPrompt } from "../src/server/moderation/guard";
import { getDb, transaction } from "../src/server/db";
import { createUser, createSession, one, all, run } from "../src/server/data/core";
import { handleApi } from "../src/server/api/router";
import { publishPost } from "../src/server/moderation/publication";
import { insertPost, postById, removePost } from "../src/server/data/posts";
import { editProfile, trends, toggleFollowUser } from "../src/server/data/people";
import { timeline } from "../src/server/data/timeline";
import { drainModeration, moderationPending, startModerationWorker, stopModerationWorker } from "../src/server/moderation/worker";

process.env.ELYTRA_DB_PATH = ":memory:";
process.env.ELYTRA_SEED_DEMO = "false";
process.env.ELYTRA_MODERATION = "false";
process.env.ELYTRA_MODERATION_ENFORCEMENT = "off";
process.env.ELYTRA_MODERATION_PUBLISH = "off";
let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
const classifier = getClassifier();
const score = (n: number) => Object.fromEntries(LABELS.map(l => [l, n])) as Scores;
await check("normalization handles Unicode, invisibles, confusables, leet and repeated letters", () => {
  assert.equal(normalizeText("  Ｈ\u200b4TЕ   youuuu "), "hate youu");
  assert.equal(normalizeText("I am gay and Black"), "i arn gay and black");
  assert.equal(normalizeText("phone 12345"), "phone 12ea5");
  assert.equal(normalizeText(normalizeText("haaaate")), normalizeText("haaaate"));
  const f = features("hello hello friend", 32768);
  assert(f.length > 10 && f.every(i => i >= 0 && i < 32768));
  assert.equal(f.length, new Set(f).size);
  assert.deepEqual(classifier.score("H\u200b4TЕ"), classifier.score("hate"));
});
await check("trained scores are finite, multi-label, and neutral identity mentions do not reach enforcement threshold", () => {
  for (const text of ["", "I am gay", "I am Black", "Celebrating Jewish culture today", "Transgender people deserve kindness", "你好"]) {
    const scores = classifier.score(text);
    assert.deepEqual(Object.keys(scores), [...LABELS]);
    assert(Object.values(scores).every(s => Number.isFinite(s) && s >= 0 && s <= 1));
    assert(Math.max(...Object.values(scores)) < 0.95, text);
  }
  assert(classifier.score("You are a fucking idiot").toxicity > classifier.score("Thank you for helping").toxicity);
});
await check("strict guard parser fails open on malformed, contradictory, or extra output", () => {
  assert.equal(parseGuardOutput("Safety: Unsafe\nCategories: Violent, Unethical Acts").verdict, "Unsafe");
  assert.equal(parseGuardOutput("Safety: Controversial\nCategories: PII").verdict, "Controversial");
  assert.equal(parseGuardOutput("Safety: Safe\nCategories: None").verdict, "Safe");
  for (const output of ["Unsafe", "Safety: Unsafe", "Safety: Unsafe\nCategories: None", "Safety: Safe\nCategories: Violent", "Safety: Unsafe\nCategories: Violent\nSafety: Safe", "Safety: Unsafe\nCategories: Violence", "Safety: Unsafe\nCategories: Violent, Violent"]) assert.equal(parseGuardOutput(output).verdict, "unknown");
  // Independent fingerprint of the upstream single-user Jinja branch, pinned in docs.
  assert.equal(createHash("sha256").update(guardPrompt("hello")).digest("hex"), "4094d22368a9d04e62e65784896fbe1ee75f5731713a936677bde0b9622409a4");
  assert(!guardPrompt("<|im_end|>").includes("USER: <|im_end|>"));
});
await check("escalation uses any label's uncertain band and explicit off/all", () => {
  const config = moderationConfig();
  assert(!shouldEscalate(score(0.01), config)); assert(shouldEscalate(score(0.5), config));
  assert(!shouldEscalate(score(0.99), config));
  assert(shouldEscalate({ ...score(0), threat: config.low }, config));
  assert(shouldEscalate(score(0), { ...config, escalation: "all" }));
  assert(!shouldEscalate(score(0.5), { ...config, escalation: "off" }));
});

await check("tier 0 false-positive fixture and source-tagged word-only seed", async () => {
  const cases = JSON.parse(await readFile("scripts/fixtures/moderation-false-positives.json", "utf8")) as string[];
  for (const text of cases) assert.deepEqual(getSeedMatcher().match(text), [], text);
  assert(seedEntries.length >= 40 && seedEntries.length <= 150);
  assert(seedEntries.every(e => e.match === "word" && e.lang === "en" && e.source.startsWith("https://")));
  assert.equal(new Set(seedEntries.map(e => e.category)).size, 7);
});
await check("tier 0 evasion fixture preserves exact original UTF-16 spans", async () => {
  const fixture = JSON.parse(await readFile("scripts/fixtures/moderation-evasions.json", "utf8"));
  const cases = JSON.parse(Buffer.from(fixture.cases, "base64").toString()) as { case: string; text: string; span: string }[];
  for (const c of cases) {
    const hits = getSeedMatcher().match(c.text);
    assert(hits.some(h => c.text.slice(h.start, h.end) === c.span), `${c.case}: exact original span missing`);
  }
  const mapped = normalizeMapped("🌷 Straße ﬃ");
  assert.equal(mapped.offsets.length, mapped.text.length);
  assert(mapped.text.includes("strasse"));
  const matcher = new SlurMatcher([{ term: "ill", severity: "high", category: "ableist", match: "word", lang: "en", exceptions: [], source: "test" }]);
  assert(matcher.match("i11").length); // both ambiguous 1-as-l positions
  assert(matcher.match("!ll").length); // !-as-i
});
await check("v1 audit migration preserves result IDs, exclusions, triggers, and rollback invariants", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("PRAGMA foreign_keys=ON; CREATE TABLE posts(id TEXT PRIMARY KEY); INSERT INTO posts VALUES('p')");
    legacy.exec(moderationResultsSchema("moderation_results").replace("(0,1,2)", "(1,2)"));
    legacy.exec("INSERT INTO moderation_results(id,item_id,item_type,revision,content_hash,tier,scores,model_version,weights_version,status,latency_ms,created_at) VALUES(42,'p','post','old','hash',1,'{}','old','old','ok',1,1)");
    legacy.exec("CREATE TABLE moderation_exclusions(post_id TEXT REFERENCES posts(id), result_id INTEGER REFERENCES moderation_results(id) ON DELETE CASCADE); INSERT INTO moderation_exclusions VALUES('p',42)");
    legacy.exec("CREATE TRIGGER cleanup AFTER DELETE ON posts BEGIN DELETE FROM moderation_results WHERE item_id=OLD.id; END");
    migrateModerationResults(legacy); migrateModerationResults(legacy);
    assert.equal(legacy.prepare("SELECT id FROM moderation_results").get()!.id, 42);
    assert.equal(legacy.prepare("SELECT result_id FROM moderation_exclusions").get()!.result_id, 42);
    assert.equal(legacy.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.deepEqual(legacy.prepare("PRAGMA foreign_key_check").all(), []);
    legacy.exec("DELETE FROM posts WHERE id='p'"); assert.equal(legacy.prepare("SELECT count(*) AS n FROM moderation_results").get()!.n, 0);
  } finally { legacy.close(); }
  const broken = new DatabaseSync(":memory:");
  try {
    broken.exec(moderationResultsSchema("moderation_results").replace("(0,1,2)", "(1,2)"));
    broken.exec("PRAGMA foreign_keys=OFF; CREATE TABLE child(result_id INTEGER REFERENCES moderation_results(id)); INSERT INTO child VALUES(999); PRAGMA foreign_keys=ON");
    assert.throws(() => migrateModerationResults(broken), /foreign key check/);
    assert(String(broken.prepare("SELECT sql FROM sqlite_master WHERE name='moderation_results'").get()!.sql).includes("(1,2)"));
    assert(!broken.prepare("SELECT 1 FROM sqlite_master WHERE name='moderation_results_v2'").get());
    assert.equal(broken.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  } finally { broken.close(); }
});

let mode = "safe", requests = 0, active = 0, maxActive = 0, lastBody: Record<string, unknown> = {};
const server = createServer(async (req, res) => {
  requests++; active++; maxActive = Math.max(maxActive, active);
  res.on("close", () => { active--; });
  let body = ""; for await (const chunk of req) body += chunk;
  lastBody = JSON.parse(body);
  const selected = mode;
  if (selected === "hang") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"content":"'); return; }
  if (selected === "slow") await new Promise(resolve => setTimeout(resolve, 60));
  if (res.destroyed) return;
  if (selected === "http") { res.writeHead(503).end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ content: selected === "malformed" ? "Safety: Unsafe\nCategories: None" : selected === "unsafe" ? "Safety: Unsafe\nCategories: Violent" : selected === "controversial" ? "Safety: Controversial\nCategories: Unethical Acts" : "Safety: Safe\nCategories: None", stopped_limit: selected === "truncated" }));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}`;
const config = { ...moderationConfig(), guardUrl: url, timeoutMs: 500, queue: 1, failures: 2, cooldownMs: 100 };
const directory = await mkdtemp(join(tmpdir(), "elytra-moderation-test-"));
try {
  await check("guard HTTP uses cached exact prompt and strictly handles successful/invalid/truncated responses", async () => {
    assert.equal((await classifyGuard("hello", config)).verdict, "Safe");
    assert.equal(lastBody.cache_prompt, true); assert.equal(lastBody.prompt, guardPrompt("hello"));
    mode = "unsafe"; assert.equal((await classifyGuard("hello", config)).verdict, "Unsafe");
    mode = "malformed"; assert.equal((await classifyGuard("hello", { ...config, guardUrl: url + "/malformed" })).status, "malformed");
    mode = "truncated"; assert.equal((await classifyGuard("hello", { ...config, guardUrl: url + "/truncated" })).verdict, "unknown");
  });
  await check("deadline includes streaming body; circuit opens then recovers with a probe", async () => {
    const c = { ...config, guardUrl: url + "/breaker", timeoutMs: 50 };
    mode = "hang";
    const start = performance.now();
    assert.equal((await classifyGuard("x", c)).status, "timeout");
    assert(performance.now() - start < 1000);
    assert.equal((await classifyGuard("x", c)).status, "timeout");
    const before = requests;
    assert.equal((await classifyGuard("x", c)).status, "circuit_open"); assert.equal(requests, before);
    await new Promise(resolve => setTimeout(resolve, 120)); mode = "safe";
    assert.equal((await classifyGuard("x", c)).verdict, "Safe");
  });
  await check("guard admission is bounded and serial, then recovers after overload", async () => {
    mode = "slow"; maxActive = 0;
    const c = { ...config, guardUrl: url + "/queue" };
    const results = await Promise.all(Array.from({ length: 6 }, () => classifyGuard("hello", c)));
    assert.equal(results.filter(r => r.status === "overloaded").length, 4);
    assert.equal(results.filter(r => r.status === "ok").length, 2); assert.equal(maxActive, 1);
    mode = "safe"; assert.equal((await classifyGuard("hello", c)).verdict, "Safe");
  });
  const user = await createUser("moderation", "Moderation", "password123");
  await check("disabled mode queues nothing and touches no guard", () => {
    insertPost(user.id, { content: "disabled moderation" });
    assert.equal(moderationPending(), 0); drainModeration();
    assert.equal(all("SELECT * FROM moderation_results").length, 0);
  });
  process.env.ELYTRA_MODERATION = "true";
  process.env.ELYTRA_MODERATION_ESCALATION = "all";
  process.env.ELYTRA_GUARD_URL = url + "/worker";
  process.env.ELYTRA_GUARD_TIMEOUT_MS = "500";
  async function flush() {
    const deadline = Date.now() + 5000;
    while (moderationPending() && Date.now() < deadline) { drainModeration(); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(moderationPending(), 0);
  }
  let root = "";
  await check("publishing posts/replies/quotes and profile fields only queues work; rollback queues nothing", async () => {
    const start = performance.now();
    root = insertPost(user.id, { content: "Hello #Moderation" });
    insertPost(user.id, { content: "reply", replyToId: root });
    insertPost(user.id, { content: "quote", quoteId: root });
    editProfile(user.id, { displayName: "New name", bio: "New biography", location: "", website: "" });
    assert(performance.now() - start < 500);
    assert.equal(all("SELECT * FROM moderation_results").length, 0);
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM moderation_jobs")!.n, 5);
    assert.throws(() => transaction(() => { insertPost(user.id, { content: "rollback" }); throw new Error("rollback"); }));
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM moderation_jobs")!.n, 5);
    const fresh = await createUser("fresh_user", "Fresh", "password123"); assert(fresh.id);
    mode = "safe"; await flush();
    const results = all<{ item_type: string; tier: number; guard_verdict: string }>("SELECT * FROM moderation_results");
    assert.equal(results.length, 24);
    for (const type of ["post", "reply", "quote", "username", "display_name", "bio"]) assert(results.some(r => r.item_type === type && r.tier === 1));
    assert.equal(all("SELECT * FROM moderation_exclusions").length, 0);
  });
  await check("shadow mode preserves visibility even for Unsafe; HTTP failure stores unknown and tier 1 scores", async () => {
    mode = "unsafe"; const id = insertPost(user.id, { content: "shadow test" }); await flush();
    assert(postById(id, null)); assert.equal(all("SELECT * FROM moderation_exclusions").length, 0);
    mode = "http"; const unavailable = insertPost(user.id, { content: "outage test" }); await flush();
    assert.equal(one<{ guard_verdict: string }>("SELECT guard_verdict FROM moderation_results WHERE item_id=? AND tier=2", unavailable)!.guard_verdict, "unknown");
    assert.equal(Object.keys(JSON.parse(one<{ scores: string }>("SELECT scores FROM moderation_results WHERE item_id=? AND tier=1", unavailable)!.scores)).length, 7);
  });
  await check("discovery enforcement is reversible, filters existing snapshots, and leaves detail/following intact", async () => {
    process.env.ELYTRA_MODERATION_ENFORCEMENT = "discovery";
    // Isolate plumbing from model quality with explicit test thresholds.
    process.env.ELYTRA_MODERATION_ENFORCE_MIN = "0";
    mode = "unsafe";
    const id = insertPost(user.id, { content: "enforced #Moderation" });
    run("UPDATE posts SET created_at=? WHERE id=?", Date.now() + 1000, root);
    const page = timeline({ kind: "search", q: "#Moderation", tab: "latest" }, null, null, { limit: 1 });
    assert(page.items.some(i => i.post.id === root)); assert(page.nextCursor);
    await flush();
    assert(one("SELECT 1 FROM moderation_exclusions WHERE post_id=?", id));
    assert(!timeline({ kind: "search", q: "#Moderation", tab: "latest" }, null, null).items.some(i => i.post.id === id));
    assert(!timeline({ kind: "home", tab: "for-you" }, null, null).items.some(i => i.post.id === id));
    assert(!timeline({ kind: "search", q: "#Moderation", tab: "latest" }, page.nextCursor, null).items.some(i => i.post.id === id));
    assert(postById(id, null));
    const follower = one<{ id: string }>("SELECT id FROM users WHERE username='fresh_user'")!.id;
    toggleFollowUser(follower, user.id);
    assert(timeline({ kind: "home", tab: "following" }, null, follower).items.some(i => i.post.id === id));
    assert(trends(100).find(t => t.tag === "moderation")?.postCount === 1);
    process.env.ELYTRA_MODERATION_ENFORCEMENT = "off";
    assert(timeline({ kind: "search", q: "#Moderation", tab: "latest" }, null, null).items.some(i => i.post.id === id));
  });
  await check("worker overload keeps every tier 1 result and records guard unknown without growing promises", async () => {
    process.env.ELYTRA_GUARD_QUEUE = "0"; process.env.ELYTRA_GUARD_URL = url + "/worker-overflow";
    mode = "slow";
    const ids = Array.from({ length: 20 }, (_, i) => insertPost(user.id, { content: `overflow ${i}` }));
    await flush();
    const rows = all<{ tier: number; status: string }>(`SELECT tier,status FROM moderation_results WHERE item_id IN (${ids.map(() => "?").join()})`, ...ids);
    assert.equal(rows.filter(r => r.tier === 1 && r.status === "ok").length, 20);
    assert.equal(rows.filter(r => r.tier === 2 && r.status === "overloaded").length, 19);
    assert.equal(rows.filter(r => r.tier === 2 && r.status === "ok").length, 1);
    delete process.env.ELYTRA_GUARD_QUEUE; process.env.ELYTRA_GUARD_URL = url + "/worker";
  });
  await check("deletion in flight erases jobs/results without resurrection; missing weights fail open", async () => {
    mode = "slow";
    const id = insertPost(user.id, { content: "delete while guard runs" }); drainModeration(); removePost(user.id, id);
    // INTEGER PRIMARY KEY can be reused after deleting the last queued job.
    const replacement = insertPost(user.id, { content: "new job after deletion" });
    await flush(); assert.equal(all("SELECT * FROM moderation_results WHERE item_id=?", id).length, 0);
    assert.equal(all("SELECT * FROM moderation_results WHERE item_id=?", replacement).length, 3);
    const original = process.env.ELYTRA_MODERATION_WEIGHTS;
    process.env.ELYTRA_MODERATION_WEIGHTS = join(directory, "missing.json");
    const missing = insertPost(user.id, { content: "missing weights" }); await flush();
    assert.equal(one<{ status: string }>("SELECT status FROM moderation_results WHERE item_id=? AND tier=1", missing)!.status, "weights_unavailable");
    if (original === undefined) delete process.env.ELYTRA_MODERATION_WEIGHTS; else process.env.ELYTRA_MODERATION_WEIGHTS = original;
    const bad = join(directory, "bad.json"); await writeFile(bad, JSON.stringify({ format: "bad" }));
    process.env.ELYTRA_MODERATION_WEIGHTS = bad; assert.throws(getClassifier);
    if (original === undefined) delete process.env.ELYTRA_MODERATION_WEIGHTS; else process.env.ELYTRA_MODERATION_WEIGHTS = original;
    const weights = JSON.parse(await readFile(moderationConfig().weights, "utf8")); assert(weights.provenance.trainingSha256);
  });
  await check("admin terms, exceptions, disabling, and invalid edits reload without a deploy", () => {
    const before = getSlurMatcher(); assert.equal(before, getSlurMatcher());
    run("INSERT INTO moderation_slur_overrides(term,severity,category,exceptions) VALUES(?,?,?,?)", "zorp", "high", "racial_ethnic", JSON.stringify(["Project zorp"]));
    const updated = getSlurMatcher(); assert.notEqual(updated, before); assert.equal(updated, getSlurMatcher());
    assert(updated.match("zorp").some(h => h.entry.term === "zorp"));
    assert.deepEqual(updated.match("Project zorp"), []);
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!;
    run("INSERT INTO moderation_slur_overrides(term,exceptions) VALUES(?,?)", high.term, JSON.stringify([`Study ${high.term}`]));
    assert.deepEqual(getSlurMatcher().match(`Study ${high.term}`), []);
    // Names ignore these exceptions, as requested.
    assert(getSlurMatcher().match(`Study ${high.term}`, true).length);
    run("UPDATE moderation_slur_overrides SET enabled=0 WHERE term='zorp'"); assert.deepEqual(getSlurMatcher().match("zorp"), []);
    const valid = getSlurMatcher();
    run("INSERT INTO moderation_slur_overrides(term,severity,category) VALUES('broken','high','unknown')");
    assert.equal(getSlurMatcher(), valid); // bad SQL cannot brick publication or discard the last valid rules
    run("DELETE FROM moderation_slur_overrides"); assert(getSlurMatcher().match(high.term).length);
  });
  await check("name validation rejects only high-severity substrings at signup and profile edit in shadow mode", async () => {
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!.term;
    await assert.rejects(() => createUser(`x${high}x`, "Ordinary", "password123"), /name contains/);
    await assert.rejects(() => createUser("safe_name", `X${high}X`, "password123"), /name contains/);
    assert.throws(() => editProfile(user.id, { displayName: `X${high}X`, bio: "", location: "", website: "" }), /name contains/);
    const reclaimed = await createUser("queer_gardener", "Queer gardener", "password123"); assert(reclaimed.id);
    assert(one("SELECT 1 FROM moderation_results WHERE tier=0 AND status='rejected_name'"));
    mode = "safe"; await flush();
  });
  await check("high hits record exact spans/review recommendations in shadow mode; ambiguous hits alone do not escalate", async () => {
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!.term;
    process.env.ELYTRA_MODERATION_ESCALATION = "off";
    const top = insertPost(user.id, { content: `Discussing the word ${high}` });
    const target = one<{ id: string }>("SELECT id FROM users WHERE username='fresh_user'")!.id;
    const directed = insertPost(target, { content: high, replyToId: root });
    await flush();
    for (const id of [top, directed]) {
      assert(postById(id, null));
      const result = one<{ hits: string }>("SELECT hits FROM moderation_results WHERE item_id=? AND tier=0", id)!;
      const hits = JSON.parse(result.hits); assert(hits.length);
      const content = one<{ content: string }>("SELECT content FROM posts WHERE id=?", id)!.content;
      assert.equal(content.slice(hits[0].start, hits[0].end), high);
    }
    assert.equal(one<{ recommendation: string }>("SELECT recommendation FROM moderation_reviews WHERE item_id=?", top)!.recommendation, "reduce_reach");
    assert.equal(one<{ recommendation: string }>("SELECT recommendation FROM moderation_reviews WHERE item_id=?", directed)!.recommendation, "hold");
    process.env.ELYTRA_MODERATION_ESCALATION = "borderline";
    const before = requests;
    const ambiguous = insertPost(target, { content: "Queer joy is welcome here", replyToId: root }); await flush();
    assert.equal(requests, before); assert(postById(ambiguous, null));
    assert(!one("SELECT 1 FROM moderation_reviews WHERE item_id=?", ambiguous));
    assert(!one("SELECT 1 FROM moderation_results WHERE item_id=? AND tier=2", ambiguous));
    const h = getSeedMatcher().match("Queer joy is welcome here");
    assert.notDeepEqual(features("Queer joy is welcome here", 32768, h), features("Queer joy is welcome here", 32768, []));
    assert(guardPrompt("Queer joy is welcome here", h).includes('"ambiguous":1'));
    process.env.ELYTRA_MODERATION_ESCALATION = "all";
  });
  await check("opt-in directed holds and top-level reach reduction are reversible and never delete", async () => {
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!.term;
    const author = one<{ id: string }>("SELECT id FROM users WHERE username='fresh_user'")!.id;
    process.env.ELYTRA_SLUR_ACTION = "review"; process.env.ELYTRA_MODERATION_ESCALATION = "off";
    const reply = insertPost(author, { content: high, replyToId: root });
    const top = insertPost(author, { content: `${high} #LexicalReview` });
    const mention = insertPost(author, { content: `${high} @moderation` });
    await flush();
    assert.equal(postById(reply, null), null); assert.equal(postById(mention, null), null);
    assert(postById(top, null));
    assert(!timeline({ kind: "search", q: "#LexicalReview", tab: "latest" }, null, null).items.some(i => i.post.id === top));
    assert(!trends(100).some(t => t.tag === "lexicalreview"));
    for (const id of [reply, top, mention]) assert(one("SELECT 1 FROM posts WHERE id=?", id));
    run("UPDATE moderation_reviews SET state='approved',reviewed_at=? WHERE item_id IN (?,?,?)", Date.now(), reply, top, mention);
    assert(postById(reply, null)); assert(postById(mention, null));
    assert(timeline({ kind: "search", q: "#LexicalReview", tab: "latest" }, null, null).items.some(i => i.post.id === top));
    process.env.ELYTRA_SLUR_ACTION = "shadow"; process.env.ELYTRA_MODERATION_ESCALATION = "all";
  });
  await check("optional directed rejection uses the composer message while ambiguous and self-replies remain allowed", async () => {
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!.term;
    const author = one<{ id: string }>("SELECT id FROM users WHERE username='fresh_user'")!.id;
    process.env.ELYTRA_SLUR_ACTION = "reject-directed";
    assert.throws(() => insertPost(author, { content: high, replyToId: root }), { message: "This post contains a term that isn't allowed" });
    assert.throws(() => insertPost(author, { content: `${high} @moderation` }), /This post contains/);
    assert(insertPost(author, { content: "Queer joy is welcome here", replyToId: root }));
    assert(insertPost(user.id, { content: high, replyToId: root })); // one's own post
    mode = "safe"; await flush();
    assert(one("SELECT 1 FROM moderation_results WHERE tier=0 AND status='rejected_directed'"));
    process.env.ELYTRA_SLUR_ACTION = "shadow";
  });
  await check("Qwen Safe releases a lexical hold; late model output does not override human review", async () => {
    const high = seedEntries.find(e => e.severity === "high" && e.category === "racial_ethnic")!.term;
    const author = one<{ id: string }>("SELECT id FROM users WHERE username='fresh_user'")!.id;
    process.env.ELYTRA_SLUR_ACTION = "review";
    mode = "slow";
    const id = insertPost(author, { content: `Discussing ${high}`, replyToId: root }); drainModeration();
    assert.equal(postById(id, null), null); await flush(); assert(postById(id, null));
    const manual = insertPost(author, { content: `Quoted ${high}`, replyToId: root }); drainModeration();
    run("UPDATE moderation_reviews SET state='restricted',reviewed_at=? WHERE item_id=?", Date.now(), manual);
    await flush(); assert.equal(postById(manual, null), null);
    process.env.ELYTRA_SLUR_ACTION = "shadow"; assert(postById(manual, null));
  });
  await check("background poller resumes durable outbox without another publication", async () => {
    mode = "safe"; const id = insertPost(user.id, { content: "resume pending work" });
    startModerationWorker(); await new Promise(resolve => setTimeout(resolve, 400)); stopModerationWorker(); await flush();
    assert(one("SELECT 1 FROM moderation_results WHERE item_id=? AND tier=1", id));
  });
  await check("blocking publication rejects posts/replies/quotes through REST before any public write", async () => {
    await flush();
    process.env.ELYTRA_MODERATION_PUBLISH = "block";
    process.env.ELYTRA_MODERATION_ESCALATION = "off"; // Explicit blocking still checks every submission.
    mode = "unsafe";
    const token = createSession(user.id).token;
    const counts = () => ["posts", "notifications", "hashtags", "post_images", "mentions"].map(table => one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);
    const before = counts();
    for (const extra of [{}, { replyToId: root }, { quoteId: root }]) {
      const response = await handleApi(new Request("http://localhost/api/v1/posts", { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "I will kill you and your family. #blocked @moderation", ...extra }) }));
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json()).error, { code: "moderated_text", message: "This content isn't allowed" });
      assert.deepEqual(counts(), before);
    }
    assert(one("SELECT 1 FROM moderation_results WHERE item_id LIKE 'rejected:%' AND tier=2 AND guard_verdict='Unsafe'"));
  });
  await check("blocking publication allows Safe/Controversial and reuses all three audit tiers", async () => {
    for (const verdict of ["safe", "controversial"]) {
      mode = verdict;
      const before = requests, id = await publishPost(user.id, { content: "Queer joy and Black history belong here." });
      assert(postById(id, null));
      assert.equal(requests, before + 1);
      assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM moderation_results WHERE item_id=?", id)!.n, 3);
      assert(!one("SELECT 1 FROM moderation_jobs WHERE item_id=?", id));
      drainModeration(); assert.equal(requests, before + 1);
    }
  });
  await check("blocking publication keeps drafts unpublished on malformed/unavailable guard without calling them unsafe", async () => {
    const before = one<{ n: number }>("SELECT count(*) AS n FROM posts")!.n;
    for (const failure of ["malformed", "http", "hang"]) {
      mode = failure;
      await assert.rejects(publishPost(user.id, { content: "A harmless draft awaiting a working checker." }),
        { status: 503, code: "moderation_unavailable" });
      assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM posts")!.n, before);
    }
    const latest = one<{ guard_verdict: string }>("SELECT guard_verdict FROM moderation_results WHERE tier=2 ORDER BY id DESC LIMIT 1")!;
    assert.equal(latest.guard_verdict, "unknown");
    process.env.ELYTRA_MODERATION_PUBLISH = "off";
    mode = "safe";
  });
  await check("explicit term blocks reject full/short slurs and evasions before guard, with live reversal and word boundaries", async () => {
    process.env.ELYTRA_MODERATION_PUBLISH = "block";
    const fixture = JSON.parse(await readFile("scripts/fixtures/moderation-publish-blocks.json", "utf8"));
    const cases = JSON.parse(Buffer.from(fixture.cases, "base64").toString()) as { terms: string[]; blocked: string[]; allowed: string[] };
    for (const term of cases.terms) run("INSERT INTO moderation_slur_overrides(term,reject_publish) VALUES(?,1)", term);
    const before = requests, postCount = one<{ n: number }>("SELECT count(*) AS n FROM posts")!.n;
    // A permissive or unavailable model cannot overrule the operator's explicit term policy.
    for (const model of ["safe", "http"]) {
      mode = model;
      for (const content of cases.blocked) for (const extra of [{}, { replyToId: root }, { quoteId: root }]) {
        await assert.rejects(publishPost(user.id, { content, ...extra }), { status: 400, code: "moderated_text", message: "This content isn't allowed" });
      }
    }
    assert.equal(requests, before);
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM posts")!.n, postCount);
    assert(one("SELECT 1 FROM moderation_results WHERE tier=0 AND status='rejected_publish_term'"));
    mode = "safe";
    // Use a fresh circuit after the previous test deliberately opened its circuit.
    const originalUrl = process.env.ELYTRA_GUARD_URL;
    process.env.ELYTRA_GUARD_URL = url + "/publication-terms";
    try {
      for (const content of cases.allowed) assert(await publishPost(user.id, { content }));
      run("UPDATE moderation_slur_overrides SET reject_publish=0 WHERE term=?", cases.terms[0]);
      assert(await publishPost(user.id, { content: cases.terms[0] }));
      run("UPDATE moderation_slur_overrides SET reject_publish=1 WHERE term=?", cases.terms[0]);
      await assert.rejects(publishPost(user.id, { content: cases.terms[0] }), { code: "moderated_text" });
      run("UPDATE moderation_slur_overrides SET enabled=0 WHERE term=?", cases.terms[0]);
      assert(await publishPost(user.id, { content: cases.terms[0] }));
    } finally {
      process.env.ELYTRA_GUARD_URL = originalUrl;
      run("DELETE FROM moderation_slur_overrides");
      process.env.ELYTRA_MODERATION_PUBLISH = "off";
    }
  });
  await check("explicit-term policy migration preserves existing overrides and defaults to contextual handling", () => {
    const db = getDb();
    db.exec("ALTER TABLE moderation_slur_overrides DROP COLUMN reject_publish");
    run("INSERT INTO moderation_slur_overrides(term,severity,category,exceptions) VALUES('zorp','high','racial_ethnic','[\"Project zorp\"]')");
    migrateBackend(db); migrateBackend(db);
    const row = one<{ reject_publish: number; exceptions: string }>("SELECT reject_publish,exceptions FROM moderation_slur_overrides WHERE term='zorp'")!;
    assert.equal(row.reject_publish, 0); assert.equal(row.exceptions, '["Project zorp"]');
    run("DELETE FROM moderation_slur_overrides WHERE term='zorp'");
  });
  console.log(`${checks} moderation checks passed`);
} finally {
  stopModerationWorker(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true }); getDb().close();
}

import "server-only";
import assert from "node:assert/strict";
import { getDb } from "../src/server/db";
import { all, one, run, authenticate, createUser, createSession, viewerForToken, deleteSession, userByUsername } from "../src/server/data/core";
import { insertPost, postById, postThread, removePost, togglePostInteraction } from "../src/server/data/posts";
import { profileByUsername, toggleFollowUser, followersOf, findUsers, suggestedUsers, notificationsFor, unreadCount, readNotifications, trends, editProfile } from "../src/server/data/people";
import { timeline, validTimelineSource } from "../src/server/data/timeline";
import { validateImage, saveImage, removeImages, validMediaName, uploadDirectory } from "../src/server/media";
import { readFile, access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineSource } from "@/lib/types";
import { rankForYou } from "../src/server/data/recommendations";
import { saveImpressions, saveNotInterested, savePostVisit, postAnalytics } from "../src/server/data/feedback";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// Never mutate the running app's database.
process.env.ELYTRA_DB_PATH = ":memory:";
const db = getDb();
let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
await check("seed: 8 users, 42 posts, threads, tags, and social activity", async () => {
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n, 8);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM posts")!.n, 42);
  assert(trends(5).length > 0);
  assert(postThread("seed_post_35", null)!.ancestors.length === 3);
  for (const username of ["theo", "demo", "sarah", "marcus", "priya", "alex", "jules", "maya"]) assert(await authenticate(username, "password123"));
  const hashes = all<{ password_hash: string }>("SELECT password_hash FROM users");
  assert.equal(new Set(hashes.map(r => r.password_hash)).size, 8);
});
const alice = await createUser("test_alice", "Alice Test", "securepass123");
const bob = await createUser("test_bob", "Bob Test", "securepass123");
const carol = await createUser("test_carol", "Carol Test", "securepass123");
await check("authentication, case-insensitive uniqueness, and hashed expiring sessions", async () => {
  assert.equal((await authenticate("TEST_ALICE", "securepass123"))?.id, alice.id);
  assert.equal(await authenticate("test_alice", "wrong password"), null);
  assert.equal(await authenticate("no_such_user", "wrong password"), null);
  await assert.rejects(() => createUser("TEST_ALICE", "Another Alice", "securepass123"));
  await assert.rejects(() => createUser("!", "No", "securepass123"));
  const session = createSession(alice.id);
  assert.equal(session.token.length, 64);
  assert.equal(viewerForToken(session.token)?.id, alice.id);
  assert.equal(one<{ token_hash: string }>("SELECT token_hash FROM sessions")!.token_hash.length, 64);
  assert.notEqual(one<{ token_hash: string }>("SELECT token_hash FROM sessions")!.token_hash, session.token);
  run("UPDATE sessions SET expires_at=0");
  assert.equal(viewerForToken(session.token), null);
  const next = createSession(alice.id);
  deleteSession(next.token);
  assert.equal(viewerForToken(next.token), null);
});
await check("follow flags, lists, suggestions, notifications, and undo", async () => {
  assert.equal(toggleFollowUser(alice.id, bob.id), true);
  assert.equal(profileByUsername("TEST_BOB", alice.id)?.isFollowing, true);
  assert.equal(profileByUsername("test_alice", bob.id)?.followsYou, true);
  assert.equal(followersOf("test_bob", alice.id, "followers")[0].id, alice.id);
  assert.equal(followersOf("test_alice", bob.id, "following")[0].id, bob.id);
  assert(!suggestedUsers(100, alice.id).some(u => u.id === alice.id || u.id === bob.id));
  assert.equal(findUsers("Bob Test", 20, alice.id)[0].id, bob.id);
  assert.equal(notificationsFor(bob.id).filter(n => n.type === "follow").length, 1);
  assert.equal(toggleFollowUser(alice.id, bob.id), false);
  assert.equal(notificationsFor(bob.id).filter(n => n.type === "follow").length, 0);
  assert.throws(() => toggleFollowUser(alice.id, alice.id));
  toggleFollowUser(alice.id, bob.id);
});
const root = insertPost(bob.id, { content: "  Hello #BackendTest @test_carol  " });
const reply = insertPost(alice.id, { content: "Reply @test_bob #BackendTest", replyToId: root });
const grandchild = insertPost(bob.id, { content: "A reply to the reply", replyToId: reply });
const quote = insertPost(carol.id, { content: "", quoteId: root });
await check("posts, mentions, quotes, and deduplicated reply notifications", async () => {
  assert.equal(postById(root, alice.id)?.content, "Hello #BackendTest @test_carol");
  assert.equal(postById(reply, alice.id)?.replyToUsername, "test_bob");
  assert.equal(postById(quote, null)?.quote?.id, root);
  assert.deepEqual(postThread(grandchild, alice.id)!.ancestors.map(p => p.id), [root, reply]);
  assert.equal(notificationsFor(bob.id).filter(n => n.post?.id === reply).length, 1);
  assert.equal(notificationsFor(bob.id).find(n => n.post?.id === reply)?.type, "reply");
  assert(notificationsFor(carol.id).some(n => n.type === "mention" && n.post?.id === root));
  assert(!notificationsFor(alice.id).some(n => n.actor.id === alice.id));
  assert.throws(() => insertPost(alice.id, { content: "" }));
  assert.throws(() => insertPost(alice.id, { content: "x".repeat(281) }));
  assert.throws(() => insertPost(alice.id, { content: "x", quoteId: "missing" }));
});
await check("likes, reposts, bookmarks, ownership, and signed-out flags", async () => {
  assert.deepEqual(togglePostInteraction(alice.id, root, "like"), { active: true, count: 1 });
  assert.equal(postById(root, alice.id)?.viewer.liked, true);
  assert.equal(postById(root, null)?.viewer.liked, false);
  assert.equal(togglePostInteraction(alice.id, root, "like").active, false);
  assert(!notificationsFor(bob.id).some(n => n.type === "like" && n.post?.id === root));
  togglePostInteraction(alice.id, root, "like");
  assert.equal(togglePostInteraction(alice.id, root, "repost").active, true);
  assert.equal(togglePostInteraction(alice.id, root, "bookmark").active, true);
  assert.equal(timeline({ kind: "bookmarks" }, null, alice.id).items[0].post.id, root);
  assert.equal(timeline({ kind: "bookmarks" }, null, null).items.length, 0);
  assert.throws(() => removePost(alice.id, root));
});
const ownReply = insertPost(bob.id, { content: "Author's own reply", replyToId: root });
const popularReply = insertPost(carol.id, { content: "A popular reply", replyToId: root });
togglePostInteraction(alice.id, popularReply, "like");
await check("thread reply ordering: author, likes, oldest", async () => {
  assert.deepEqual(postThread(root, null)!.replies.map(p => p.id), [ownReply, popularReply, reply]);
});
for (let i = 0; i < 47; i++) insertPost(bob.id, { content: `Pagination item ${i} #PaginationTest` });
await check("stable pagination through 3 pages despite new posts and popularity changes", async () => {
  const source: TimelineSource = { kind: "search", q: "#PaginationTest", tab: "top" };
  let page = timeline(source, null, alice.id);
  assert.equal(page.items.length, 20);
  assert(page.nextCursor);
  const keys = page.items.map(i => i.key);
  const original = all<{ id: string }>("SELECT id FROM posts WHERE content LIKE 'Pagination item%'").map(r => `post:${r.id}`);
  const newest = insertPost(bob.id, { content: "Pagination item added after snapshot #PaginationTest" });
  togglePostInteraction(alice.id, original[0].slice(5), "like");
  let pages = 1;
  while (page.nextCursor) {
    page = timeline(source, page.nextCursor, alice.id);
    keys.push(...page.items.map(i => i.key));
    pages++;
    assert(pages < 10);
  }
  assert.equal(pages, 3);
  assert.equal(keys.length, 47);
  assert.equal(new Set(keys).size, 47);
  assert.deepEqual([...keys].sort(), original.sort());
  assert(!keys.includes(`post:${newest}`));
  assert.equal(timeline(source, "bogus", alice.id).items.length, 0);
  assert(!validTimelineSource({ kind: "user", username: [], tab: "posts" }));
  assert(!validTimelineSource({ kind: "search", q: 4, tab: "top" }));
  assert(!validTimelineSource({ kind: "user", username: "demo", tab: ["posts"] }));
});
await check("every timeline source and viewer-specific event selection", async () => {
  const following = timeline({ kind: "home", tab: "following" }, null, alice.id);
  assert(following.items.length > 0);
  assert(following.items.every(i => (i.repostedBy?.id ?? i.post.author.id) === bob.id));
  assert.equal(timeline({ kind: "home", tab: "following" }, null, null).items.length, 0);
  assert(timeline({ kind: "user", username: "test_alice", tab: "posts" }, null, alice.id).items.some(i => i.repostedBy?.id === alice.id && i.post.id === root));
  assert(timeline({ kind: "user", username: "test_alice", tab: "replies" }, null, alice.id).items.some(i => i.post.id === reply));
  assert.equal(timeline({ kind: "user", username: "test_alice", tab: "likes" }, null, null).items.length, 3);
  assert.equal(timeline({ kind: "search", q: "@test_carol", tab: "latest" }, null, null).items[0].post.id, root);
  assert.equal(timeline({ kind: "search", q: "hello #BACKENDTEST", tab: "latest" }, null, null).items[0].post.id, root);
  assert.equal(timeline({ kind: "search", q: "#backendtest", tab: "latest" }, null, null).items.length, 2);
  assert.equal(timeline({ kind: "search", q: "hello", tab: "media" }, null, null).items.length, 0);
  assert.equal(timeline({ kind: "user", username: "missing", tab: "posts" }, null, null).items.length, 0);
  const page = timeline({ kind: "home", tab: "for-you" }, null, alice.id);
  assert(page.items.length > 0);
  // This fixture has only one followed author; diversity may produce a short For You feed.
  // Ranked multi-page cursor isolation is covered below with several eligible authors.
  assert(following.nextCursor);
  assert.equal(timeline({ kind: "home", tab: "following" }, following.nextCursor, bob.id).items.length, 0);
  assert.equal(timeline({ kind: "search", q: "hello", tab: "top" }, following.nextCursor, alice.id).items.length, 0);
});
await check("Following selects followed accounts, preserves their reposts, and rechecks follows during pagination", async () => {
  const viewer = await createUser("follow_viewer", "Following Viewer", "password123");
  const friend = await createUser("follow_friend", "Following Friend", "password123");
  const stranger = await createUser("follow_stranger", "Following Stranger", "password123");
  const source: TimelineSource = { kind: "home", tab: "following" };
  const own = insertPost(viewer.id, { content: "Own post" });
  const outside = insertPost(stranger.id, { content: "Outside post" });
  togglePostInteraction(viewer.id, outside, "repost");
  assert.deepEqual(timeline(source, null, viewer.id).items, []);
  toggleFollowUser(viewer.id, friend.id);
  const original = insertPost(friend.id, { content: "Followed post" });
  togglePostInteraction(friend.id, outside, "repost");
  const items = timeline(source, null, viewer.id).items;
  assert(items.some(i => i.post.id === original && !i.repostedBy));
  assert(items.some(i => i.post.id === outside && i.repostedBy?.id === friend.id));
  assert(!items.some(i => i.post.id === own || i.repostedBy?.id === viewer.id));
  assert(items.every(i => (i.repostedBy?.id ?? i.post.author.id) === friend.id));
  const page = timeline(source, null, viewer.id, { limit: 1 });
  assert(page.nextCursor);
  toggleFollowUser(viewer.id, friend.id, false);
  assert.deepEqual(timeline(source, page.nextCursor, viewer.id).items, []);
  assert.deepEqual(timeline(source, null, viewer.id).items, []);
});
await check("search top uses recent matches and falls back to all time", async () => {
  const old = insertPost(bob.id, { content: "#OldOnlyExample #RecentWindowExample" });
  run("UPDATE posts SET created_at=? WHERE id=?", Date.now() - 40 * 86400000, old);
  const recent = insertPost(bob.id, { content: "#RecentWindowExample" });
  togglePostInteraction(alice.id, old, "like");
  assert.deepEqual(timeline({ kind: "search", q: "#RecentWindowExample", tab: "top" }, null, null).items.map(i => i.post.id), [recent]);
  assert.deepEqual(timeline({ kind: "search", q: "#OldOnlyExample", tab: "top" }, null, null).items.map(i => i.post.id), [old]);
});
await check("profile edits, read markers, and mentions-only filters", async () => {
  editProfile(alice.id, { displayName: "Alice Updated", bio: "New bio", location: "Regina", website: "https://example.com" });
  assert.equal(profileByUsername("test_alice", alice.id)?.displayName, "Alice Updated");
  assert(unreadCount(bob.id) > 0);
  assert(notificationsFor(bob.id, true).every(n => n.type === "reply" || n.type === "mention"));
  readNotifications(bob.id);
  assert.equal(unreadCount(bob.id), 0);
  assert.equal(notificationsFor(null).length, 0);
});
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=", "base64");
const image = await validateImage(new File([imageBytes], "pixel.png", { type: "image/png" }));
const imageUrl = await saveImage(image);
try {
  assert.deepEqual(await readFile(join(uploadDirectory(), imageUrl.split("/").pop()!)), imageBytes);
  const mediaPost = insertPost(alice.id, { content: "", imageUrls: [imageUrl] });
  assert.equal(postById(mediaPost, alice.id)?.imageUrls[0], imageUrl);
  assert(timeline({ kind: "user", username: "test_alice", tab: "media" }, null, null).items.some(i => i.post.id === mediaPost));
  assert.equal(removePost(alice.id, mediaPost)[0], imageUrl);
  await assert.rejects(validateImage(new File(["fake image"], "fake.png", { type: "image/png" })));
  await assert.rejects(validateImage(new File([imageBytes], "wrong.jpg", { type: "image/jpeg" })));
  await assert.rejects(validateImage(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })));
  assert.equal(validMediaName("../secret.png"), false);
  assert.equal(validMediaName("foo.svg"), false);
  console.log("PASS image magic bytes, MIME/size validation, media timelines, and file cleanup"); checks++;
} finally { await removeImages([imageUrl]); }
await assert.rejects(access(join(uploadDirectory(), imageUrl.split("/").pop()!)));
await check("deletion cascades activity and preserves replies and quote tombstones", async () => {
  removePost(bob.id, root);
  assert.equal(postById(root, null), null);
  assert.equal(postById(reply, null)?.replyToId, root);
  assert.equal(postById(reply, null)?.replyToUsername, null);
  assert.deepEqual(postThread(reply, null)?.ancestors, []);
  assert.equal(postById(quote, null)?.quote?.deleted, true);
  for (const table of ["likes", "reposts", "bookmarks", "mentions", "hashtags", "notifications"]) assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE post_id=?`, root)!.n, 0);
  assert(!timeline({ kind: "bookmarks" }, null, alice.id).items.some(i => i.post.id === root));
  assert.equal(userByUsername("test_bob")?.id, bob.id);
});
// Independent recommendation fixture: controlled ages, equal popularity, and two network pools.
const rankViewer = await createUser("rank_viewer", "Rank Viewer", "password123");
const friend = await createUser("rank_friend", "Rank Friend", "password123");
const secondFriend = await createUser("rank_second", "Second Friend", "password123");
const close = await createUser("rank_close", "Close Author", "password123");
const stranger = await createUser("rank_stranger", "Stranger", "password123");
const isolated = await createUser("rank_isolated", "Isolated", "password123");
const topicAuthor = await createUser("rank_topic", "Topic Author", "password123");
const newViewer = await createUser("rank_new", "New Viewer", "password123");
const rankNow = Date.now();
const forYou: TimelineSource = { kind: "home", tab: "for-you" };
const makeRankPost = (author: string, content: string, age = 0, parent?: string) => {
  const id = insertPost(author, { content, replyToId: parent });
  run("UPDATE posts SET created_at=? WHERE id=?", rankNow - age, id);
  return id;
};
toggleFollowUser(rankViewer.id, friend.id);
toggleFollowUser(rankViewer.id, secondFriend.id);
for (let i = 0; i < 6; i++) {
  const id = makeRankPost(close.id, `Historical interest ${i} #RankCode #RankDesign`, 2 * 86400000);
  togglePostInteraction(rankViewer.id, id, "like");
  if (i < 3) togglePostInteraction(rankViewer.id, id, "bookmark");
}
const closeIds: string[] = [], strangerIds: string[] = [];
for (let i = 0; i < 18; i++) {
  makeRankPost(friend.id, `Network one ${i}`);
  makeRankPost(secondFriend.id, `Network two ${i}`);
  const a = makeRankPost(close.id, `Close candidate ${i}`);
  const b = makeRankPost(stranger.id, `Stranger candidate ${i}`);
  closeIds.push(a); strangerIds.push(b);
  togglePostInteraction(friend.id, a, "like");
  togglePostInteraction(friend.id, b, "like");
}
const own = makeRankPost(rankViewer.id, "Viewer's own post");
const noProof = makeRankPost(isolated.id, "Popular but no personalized proof");
for (const u of [friend, secondFriend, alice, bob, carol]) {
  // No followed accounts engage this post: use only unrelated actors for popularity.
  if (u.id !== friend.id && u.id !== secondFriend.id) togglePostInteraction(u.id, noProof, "like");
}
const similar = makeRankPost(topicAuthor.id, "Strong shared interest #RankCode #RankDesign");
const weakSimilar = makeRankPost(topicAuthor.id, "Only one shared tag #RankCode");
const conversationRoot = makeRankPost(stranger.id, "Conversation root");
const sibling = makeRankPost(close.id, "Conversation sibling", 0, conversationRoot);
const nested = makeRankPost(friend.id, "Nested reply", 0, sibling);
for (const id of [conversationRoot, sibling]) togglePostInteraction(friend.id, id, "like");
togglePostInteraction(friend.id, closeIds[0], "repost");
const ranked = rankForYou(rankViewer.id, rankNow);
await check("For You: relationship ranking, social proof, strong topic similarity, and own-post exclusion", async () => {
  const a = ranked.find(p => p.id === closeIds[1])!, b = ranked.find(p => p.id === strangerIds[1])!;
  assert(a && b);
  assert(a.score > b.score);
  assert(ranked.indexOf(a) < ranked.indexOf(b));
  assert(a.relationship > b.relationship);
  assert.deepEqual(b.socialProof, [friend.id]);
  assert(!ranked.some(p => p.id === noProof || p.id === own || p.id === weakSimilar));
  assert(ranked.some(p => p.id === similar && p.similarity >= 0.6));
});
await check("For You: roughly 50/50 mixing, author diversity, canonical reposts, and conversation deduplication", async () => {
  const first = ranked.slice(0, 20);
  assert.equal(first.filter(p => p.inNetwork).length, 10);
  for (let i = 2; i < ranked.length; i++) assert(!(ranked[i].author_id === ranked[i - 1].author_id && ranked[i].author_id === ranked[i - 2].author_id));
  assert.equal(ranked.filter(p => p.id === closeIds[0]).length, 1);
  assert.equal(ranked.find(p => p.id === closeIds[0])?.reposterId, friend.id);
  assert.equal(ranked.filter(p => [conversationRoot, sibling, nested].includes(p.id)).length, 1);
  assert.equal(new Set(ranked.map(p => p.id)).size, ranked.length);
  assert.equal(new Set(ranked.map(p => p.conversation)).size, ranked.length);
});
await check("For You: frozen ranked pagination has no gaps/duplicates, cross-viewer/source rejection, and expiry", async () => {
  let page = timeline(forYou, null, rankViewer.id);
  assert.equal(page.items.length, 20); assert(page.nextCursor);
  const cursor = page.nextCursor;
  const [snapshotId] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, number];
  const expected = JSON.parse(one<{ entries: string }>("SELECT entries FROM timeline_snapshots WHERE id=?", snapshotId)!.entries) as { postId: string }[];
  assert.equal(expected.length, ranked.length);
  assert.equal(timeline(forYou, cursor, newViewer.id).items.length, 0);
  assert.equal(timeline({ kind: "home", tab: "following" }, cursor, rankViewer.id).items.length, 0);
  assert.equal(timeline(forYou, Buffer.from(JSON.stringify([snapshotId, -1])).toString("base64url"), rankViewer.id).items.length, 0);
  const newest = makeRankPost(friend.id, "Arrived after ranking");
  togglePostInteraction(friend.id, strangerIds[1], "repost");
  // Mark an unserved snapshot entry seen: this must not change that snapshot's ordering.
  saveImpressions(rankViewer.id, [expected[25].postId], rankNow);
  const received = page.items.map(p => p.post.id);
  let pages = 1;
  while (page.nextCursor) {
    page = timeline(forYou, page.nextCursor, rankViewer.id);
    received.push(...page.items.map(p => p.post.id));
    assert(++pages < 20);
  }
  assert.deepEqual(received, expected.map(p => p.postId));
  assert.equal(new Set(received).size, received.length);
  assert(!received.includes(newest));
  run("UPDATE timeline_snapshots SET created_at=0 WHERE id=?", snapshotId);
  assert.equal(timeline(forYou, cursor, rankViewer.id).items.length, 0);
});
await check("For You: signed-out and brand-new viewers receive the same popular cold-start fallback", async () => {
  const signedOut = rankForYou(null, rankNow), fresh = rankForYou(newViewer.id, rankNow);
  assert.deepEqual(signedOut.map(p => p.id), fresh.map(p => p.id));
  assert(signedOut.some(p => p.id === noProof));
  assert(signedOut.length > 20);
  assert(signedOut.find(p => p.id === noProof)!.score > signedOut.find(p => p.id === own)!.score);
  assert(timeline(forYou, null, null).items.length === 20);
});
await check("post analytics: views and visits skip the author and repeats, and only the author reads them", async () => {
  const id = insertPost(alice.id, { content: "Analytics target" }), t = 5_000_000;
  assert.equal(postById(id, alice.id)!.viewCount, 0);
  assert.equal(postById(id, bob.id)!.viewCount, null);
  saveImpressions(alice.id, [id], t);
  saveImpressions(bob.id, [id, id], t);
  saveImpressions(bob.id, [id], t + 1000);
  saveImpressions(bob.id, [id], t + 61_000);
  saveImpressions(carol.id, [id], t);
  assert.equal(postById(id, alice.id)!.viewCount, 3);
  savePostVisit(bob.id, id, "detail", t + 200_000);
  savePostVisit(bob.id, id, "detail", t + 201_000);
  savePostVisit(carol.id, id, "profile", t);
  savePostVisit(alice.id, id, "detail", t);
  savePostVisit(alice.id, id, "profile", t);
  savePostVisit(bob.id, "removed_post", "detail", t);
  assert.throws(() => savePostVisit(bob.id, id, "bogus" as "detail"));
  togglePostInteraction(bob.id, id, "like", true);
  const stats = postAnalytics(alice.id, id);
  assert.deepEqual(stats, { impressions: 4, detailExpands: 1, profileVisits: 1, replies: 0, reposts: 0, likes: 1, bookmarks: 0, engagements: 3 });
  assert.throws(() => postAnalytics(bob.id, id), /Only the author/);
  assert.throws(() => postAnalytics(alice.id, "missing"), /not found/);
  removePost(alice.id, id);
});
await check("For You: impressions are validated/idempotent, filter for 24h, fatigue later, and do not affect Following", async () => {
  assert.throws(() => saveImpressions(rankViewer.id, ["../invalid"]));
  assert.throws(() => saveImpressions(rankViewer.id, Array(101).fill(closeIds[0])));
  const id = closeIds[2];
  saveImpressions(rankViewer.id, [id, id, "removed_post"], rankNow);
  saveImpressions(rankViewer.id, [id], rankNow + 1000);
  assert.equal(one<{ seen_count: number }>("SELECT seen_count FROM impressions WHERE user_id=? AND post_id=?", rankViewer.id, id)!.seen_count, 1);
  assert(!rankForYou(rankViewer.id, rankNow + 1000).some(p => p.id === id));
  assert(!timeline(forYou, null, rankViewer.id).items.some(p => p.post.id === id));
  const later = rankForYou(rankViewer.id, rankNow + 25 * 3600000);
  assert(later.some(p => p.id === id));
  const fatigued = later.find(p => p.id === id)!.score;
  run("DELETE FROM impressions WHERE user_id=? AND post_id=?", rankViewer.id, id);
  assert(rankForYou(rankViewer.id, rankNow + 25 * 3600000).find(p => p.id === id)!.score > fatigued);
  const networkId = makeRankPost(friend.id, "Following ignores seen signal");
  saveImpressions(rankViewer.id, [networkId]);
  assert(timeline({ kind: "home", tab: "following" }, null, rankViewer.id).items.some(p => p.post.id === networkId));
});
await check("For You: exhausted unseen recommendations fall back to seen posts while preserving dismissals", async () => {
  const viewer = await createUser("rank_exhausted", "Exhausted Viewer", "password123");
  toggleFollowUser(viewer.id, friend.id);
  const initial = rankForYou(viewer.id, rankNow);
  assert(initial.length > 0);
  const dismissed = initial[0].id;
  saveNotInterested(viewer.id, dismissed);
  const ids = all<{ id: string }>("SELECT id FROM posts").map(p => p.id);
  for (let i = 0; i < ids.length; i += 100) saveImpressions(viewer.id, ids.slice(i, i + 100), rankNow);
  const revisited = rankForYou(viewer.id, rankNow + 1000);
  assert(revisited.length > 0);
  assert(!revisited.some(p => p.id === dismissed || p.author_id === viewer.id));
  assert(timeline(forYou, null, viewer.id).items.length > 0);
  const fresh = makeRankPost(friend.id, "Fresh post after exhausting recommendations");
  assert.deepEqual(rankForYou(viewer.id, rankNow + 1000).map(p => p.id), [fresh]);
});
await check("For You: explicit negative feedback filters a post, penalizes the author, decays, and skips active snapshots", async () => {
  const before = rankForYou(rankViewer.id, rankNow);
  const peer = closeIds[4], dismissed = closeIds[3];
  let page = timeline(forYou, null, rankViewer.id);
  assert(page.nextCursor);
  const [snapshotId] = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString()) as [string, number];
  const snapshotEntries = JSON.parse(one<{ entries: string }>("SELECT entries FROM timeline_snapshots WHERE id=?", snapshotId)!.entries) as { postId: string }[];
  const unserved = snapshotEntries[25].postId;
  assert.throws(() => saveNotInterested(rankViewer.id, "bad/id"));
  assert.throws(() => saveNotInterested(rankViewer.id, "missing_post"));
  saveNotInterested(rankViewer.id, dismissed, rankNow);
  saveNotInterested(rankViewer.id, dismissed, rankNow);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM negative_feedback WHERE user_id=? AND post_id=?", rankViewer.id, dismissed)!.n, 1);
  const after = rankForYou(rankViewer.id, rankNow);
  assert(!after.some(p => p.id === dismissed));
  assert(after.find(p => p.id === peer)!.score < before.find(p => p.id === peer)!.score);
  assert(after.find(p => p.id === peer)!.probabilities.negative > 0);
  const decayed = rankForYou(rankViewer.id, rankNow + 8 * 86400000).find(p => p.id === peer)!;
  assert(decayed.probabilities.negative < after.find(p => p.id === peer)!.probabilities.negative);
  saveNotInterested(rankViewer.id, unserved, rankNow);
  const received: string[] = [];
  while (page.nextCursor) { page = timeline(forYou, page.nextCursor, rankViewer.id); received.push(...page.items.map(p => p.post.id)); }
  assert(!received.includes(unserved));
  // Physical deletion cascades added signals too.
  const removed = makeRankPost(friend.id, "Feedback deletion");
  saveImpressions(rankViewer.id, [removed]); saveNotInterested(rankViewer.id, removed);
  removePost(friend.id, removed);
  for (const table of ["impressions", "negative_feedback"]) assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE post_id=?`, removed)!.n, 0);
});
await check("For You: bounded ranking latency with 5,000 additional recent posts and batched graph signals", async () => {
  db.exec("BEGIN");
  try {
    const post = db.prepare("INSERT INTO posts VALUES(?,?,?,?,?,?)");
    const like = db.prepare("INSERT INTO likes VALUES(?,?,?)");
    const repost = db.prepare("INSERT INTO reposts VALUES(?,?,?)");
    const tag = db.prepare("INSERT INTO hashtags VALUES(?,?)");
    const authorIds = [friend.id, secondFriend.id, close.id, stranger.id, topicAuthor.id, isolated.id];
    for (let i = 0; i < 5000; i++) {
      const id = `perf_${i}`, time = rankNow - (i % 300) * 3600000;
      post.run(id, authorIds[i % authorIds.length], `Performance fixture ${i} #RankCode #RankDesign`, null, null, time);
      like.run(friend.id, id, time); like.run(secondFriend.id, id, time);
      if (i % 3 === 0) repost.run(secondFriend.id, id, time);
      tag.run(id, "rankcode"); tag.run(id, "rankdesign");
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const page = timeline(forYou, null, rankViewer.id);
    timings.push(performance.now() - start);
    assert.equal(page.items.length, 20);
  }
  const coldStart = performance.now();
  assert.equal(timeline(forYou, null, newViewer.id).items.length, 20);
  const coldMs = performance.now() - coldStart;
  const max = Math.max(...timings);
  console.log(`TIMING For You +5,000 posts: fresh ranked page ${timings.map(n => n.toFixed(1)).join(", ")} ms; cold-start ${coldMs.toFixed(1)} ms`);
  assert(max < 100, `Fresh ranked page took ${max.toFixed(1)} ms (budget 100 ms)`);
  assert(coldMs < 100, `Cold-start page took ${coldMs.toFixed(1)} ms (budget 100 ms)`);
});
// Reopen a populated, file-backed pre-feature database; never open the app database.
const migrationDirectory = await mkdtemp(join(tmpdir(), "elytra-migration-"));
try {
  const migrationPath = join(migrationDirectory, "existing.db");
  db.prepare("VACUUM INTO ?").run(migrationPath);
  const legacy = new DatabaseSync(migrationPath);
  legacy.exec("DROP TABLE impressions; DROP TABLE negative_feedback; DROP INDEX posts_quote;");
  const countBefore = legacy.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n;
  await check("additive migrations preserve existing data, migrate HMR-cached connections, and are idempotent on reconnect", async () => {
    const cache = globalThis as typeof globalThis & { elytraDb?: DatabaseSync };
    cache.elytraDb = legacy;
    process.env.ELYTRA_DB_PATH = migrationPath;
    const migrated = getDb();
    assert.equal(migrated, legacy);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n, countBefore);
    for (const table of ["impressions", "negative_feedback"]) assert(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    for (const index of ["posts_quote", "impressions_post", "impressions_viewer_time", "negative_feedback_author", "negative_feedback_post"]) assert(migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index));
    assert(await authenticate("demo", "password123"));
    assert(await authenticate("theo", "password123"));
    migrated.close(); cache.elytraDb = undefined;
    const reconnected = getDb();
    assert.equal(reconnected.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n, countBefore);
    reconnected.close(); cache.elytraDb = db;
    process.env.ELYTRA_DB_PATH = ":memory:";
  });
} finally { await rm(migrationDirectory, { recursive: true, force: true }); }
console.log(`Backend integration checks passed: ${checks} groups; SQLite foreign keys and WAL configured; no app data changed.`);
db.close();

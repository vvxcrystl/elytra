import assert from "node:assert/strict";

// Run against a local server with seeded data, or set a shared post path explicitly.
const origin = process.env.ELYTRA_TEST_ORIGIN || "http://localhost:3000";
const path = process.env.ELYTRA_TEST_POST_PATH || "/marcus/status/seed_post_35";
const id = path.split("/").at(-1);
const request = (path, options = {}) => fetch(new URL(path, origin), { redirect: "manual", ...options });
const threadResponse = await request(`/api/v1/posts/${id}/thread`);
assert.equal(threadResponse.status, 200);
const { data: thread } = await threadResponse.json();
const response = await request(path);
assert.equal(response.status, 200, "shared posts must not redirect anonymous readers");
const html = await response.text();
for (const post of [thread.post, ...thread.ancestors, ...thread.replies]) {
  assert(html.includes(`data-post-id="${post.id}"`), `missing thread post ${post.id}`);
}
assert(html.includes("Join the conversation"));
assert(!html.includes('placeholder="Post your reply"'));
for (const field of ["og:title", "og:description", "og:url", "twitter:card"]) {
  assert(html.includes(`="${field}"`), `missing ${field} preview metadata`);
}
if (thread.post.imageUrls.length) assert(html.includes('property="og:image"'));
const missing = await request("/someone/status/nonexistent-public-post");
assert.equal(missing.status, 404);
const canonical = await request(`/wrong_author/status/${id}`);
assert.equal(canonical.status, 307);
assert.equal(canonical.headers.get("location"), path);
for (const protectedPath of ["/home", "/bookmarks", "/messages", "/settings"]) {
  const response = await request(protectedPath);
  assert.equal(response.status, 307, `${protectedPath} must remain protected`);
  assert.equal(response.headers.get("location"), "/login");
}
for (const kind of ["like", "repost", "bookmark"]) {
  const response = await request(`/api/v1/posts/${id}/${kind}`, { method: "PUT" });
  assert.equal(response.status, 401, `anonymous ${kind} must require authentication`);
}
console.log("PASS public post rendering, thread context, previews, canonical URLs, missing posts, and authentication boundaries");

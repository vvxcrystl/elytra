import "server-only";
import { authenticate, createUser, createSession, deleteSession, SESSION_AGE, userByUsername, one, run, type UserRow } from "../data/core";
import { profileByUsername, toggleFollowUser, editProfile, suggestedUsers, trends, readNotifications, unreadCount } from "../data/people";
import { insertPost, postById, postThread, removePost, togglePostInteraction } from "../data/posts";
import { timeline } from "../data/timeline";
import { usersPage, notificationsPage, markNotificationRead, relatedPostsPage, postUsersPage } from "../data/api";
import { relationship, setSafety } from "../data/safety";
import { createConversation, conversationById, conversationsFor, messagesFor, sendMessage, markConversationRead, deleteMessage, unreadMessageCount } from "../data/messages";
import { saveImpressions, saveNotInterested } from "../data/feedback";
import { createUpload, uploadById, type Upload } from "../data/uploads";
import { removeImages } from "../media";
import { transaction } from "../db";
import { AppError } from "../errors";
import { data, page, requiredViewer, pageOptions, stringValue, queryText, enumQuery, sessionCookie, rateLimit, clientKey, boundedBytes, idField, type ApiContext, type Fields } from "./http";
import { messagingIdentity, messagingBackup, registerMessagingIdentity } from "../data/encryption";
import { DM_PROTOCOL, type EncryptedEnvelope, type IdentityRegistration } from "../../lib/e2ee-contract";

export type Endpoint = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; summary: string; auth: boolean; body?: Fields;
  paged?: boolean; query?: Record<string, { enum?: string[]; maxLength?: number; required?: boolean }>;
  response: string; status?: number; bodyLimit?: number;
  handler: (ctx: ApiContext) => Response | Promise<Response>;
};
function profile(ctx: ApiContext, user: UserRow | undefined | null) {
  if (!user) throw new AppError(404, "not_found", "User not found");
  return { ...profileByUsername(user.username, ctx.viewer?.id ?? null)!, ...relationship(ctx.viewer?.id ?? null, user.id) };
}
function user(ctx: ApiContext) { return one<UserRow>("SELECT * FROM users WHERE id=?", ctx.params.id); }
function post(ctx: ApiContext) {
  const result = postById(ctx.params.id, ctx.viewer?.id ?? null);
  if (!result) throw new AppError(404, "not_found", "Post not found");
  return result;
}
function startSession(ctx: ApiContext, viewer: { id: string; username: string }) {
  const session = createSession(viewer.id);
  // Rotate the browser session when signing in through cookies; bearer logins are independent.
  if (!ctx.request.headers.has("authorization") && ctx.token) deleteSession(ctx.token);
  ctx.headers.set("Set-Cookie", sessionCookie(session.token, SESSION_AGE, session.expires));
  return { user: profile(ctx, userByUsername(viewer.username)), accessToken: session.token, tokenType: "Bearer", expiresAt: session.expires.toISOString() };
}
const credentialsBody: Fields = {
  username: { type: "string", required: true, pattern: "^[A-Za-z0-9_]{3,15}$", minLength: 3, maxLength: 15 },
  password: { type: "string", required: true, minLength: 1, maxLength: 1024 },
};
const encoded = (maxLength: number) => ({ type: "string" as const, required: true, minLength: 1, maxLength, pattern: "^[A-Za-z0-9_-]+$" });
const envelopeFields: Fields = {
  version: { type: "string", required: true, enum: [DM_PROTOCOL] }, clientId: { type: "string", required: true, minLength: 36, maxLength: 36 },
  senderKeyId: encoded(43), recipientKeyId: encoded(43), ephemeralPublicKey: encoded(122), salt: encoded(43),
  recipientIv: encoded(16), recipientCiphertext: encoded(53355), senderIv: encoded(16), senderCiphertext: encoded(53355), signature: encoded(86),
};
const endpoints: Endpoint[] = [
  { method: "POST", path: "/auth/register", summary: "Create an account and session", auth: false, body: { ...credentialsBody, password: { ...credentialsBody.password, minLength: 8 }, displayName: { type: "string", required: true, minLength: 1, maxLength: 50 } }, response: "AuthSession", status: 201, async handler(ctx) {
    rateLimit(`registration:${clientKey(ctx.request)}`, 20, 60 * 60 * 1000);
    const username = stringValue(ctx.body, "username");
    if (userByUsername(username)) throw new AppError(409, "username_taken", "That username is already taken");
    const viewer = await createUser(username, stringValue(ctx.body, "displayName"), stringValue(ctx.body, "password"));
    ctx.viewer = viewer;
    return data(startSession(ctx, viewer), 201);
  } },
  { method: "POST", path: "/auth/login", summary: "Sign in and create a session", auth: false, body: credentialsBody, response: "AuthSession", async handler(ctx) {
    rateLimit(`login:${clientKey(ctx.request)}`, 60, 60000);
    rateLimit(`login:${stringValue(ctx.body, "username").toLowerCase()}`, 10, 15 * 60000);
    const viewer = await authenticate(stringValue(ctx.body, "username"), stringValue(ctx.body, "password"));
    if (!viewer) throw new AppError(401, "invalid_credentials", "Invalid username or password");
    ctx.viewer = viewer;
    return data(startSession(ctx, viewer));
  } },
  { method: "POST", path: "/auth/logout", summary: "Revoke the current session", auth: true, response: "Success", handler(ctx) {
    if (ctx.token) deleteSession(ctx.token);
    ctx.headers.set("Set-Cookie", sessionCookie("", 0)); return data({ success: true });
  } },
  { method: "DELETE", path: "/auth/sessions", summary: "Revoke all of your sessions", auth: true, response: "Success", handler(ctx) {
    run("DELETE FROM sessions WHERE user_id=?", requiredViewer(ctx).id);
    ctx.headers.set("Set-Cookie", sessionCookie("", 0)); return data({ success: true });
  } },
  { method: "GET", path: "/users/me", summary: "Get your profile", auth: true, response: "Profile", handler: ctx => data(profile(ctx, userByUsername(requiredViewer(ctx).username))) },
  { method: "GET", path: "/users/me/encryption-backup", summary: "Get your encrypted messaging-key backup; recovery happens on your device", auth: true, response: "IdentityBackupResult", handler: ctx => data(messagingBackup(requiredViewer(ctx).id)) },
  { method: "PUT", path: "/users/me/encryption-keys", summary: "Publish an immutable messaging identity and encrypted private-key backup", auth: true, response: "PublicIdentity", body: { keyId: encoded(43), encryptionPublicKey: encoded(122), signingPublicKey: encoded(122), backupIv: encoded(16), backupCiphertext: encoded(5462), proof: encoded(86) }, handler: ctx => data(registerMessagingIdentity(requiredViewer(ctx).id, ctx.body as IdentityRegistration)) },
  { method: "GET", path: "/users/:id/encryption-keys", summary: "Get an account's public messaging keys", auth: true, response: "PublicIdentityResult", handler(ctx) { if (!user(ctx)) throw new AppError(404, "not_found", "User not found"); return data(messagingIdentity(ctx.params.id)); } },
  { method: "PATCH", path: "/users/me", summary: "Update your profile", auth: true, response: "Profile", body: {
    displayName: { type: "string", minLength: 1, maxLength: 50 }, bio: { type: "string", maxLength: 160 }, location: { type: "string", maxLength: 30 }, website: { type: "string", maxLength: 100 },
    avatarMediaId: idField, bannerMediaId: idField, removeAvatar: { type: "boolean" }, removeBanner: { type: "boolean" },
  }, async handler(ctx) {
    if (!Object.keys(ctx.body).length) throw new AppError(400, "validation_error", "Provide at least one profile field");
    const viewer = requiredViewer(ctx), current = profileByUsername(viewer.username, viewer.id)!;
    const displayName = stringValue(ctx.body, "displayName", current.displayName).trim();
    if (!displayName) throw new AppError(400, "validation_error", "Display name cannot be empty");
    let website = stringValue(ctx.body, "website", current.website).trim();
    if (website) {
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(website)) website = `https://${website}`;
      try { const url = new URL(website); if (!["http:", "https:"].includes(url.protocol) || !url.hostname || website.length > 100) throw new Error(); }
      catch { throw new AppError(400, "validation_error", "Enter a valid http or https website up to 100 characters"); }
    }
    if ((ctx.body.avatarMediaId && ctx.body.removeAvatar) || (ctx.body.bannerMediaId && ctx.body.removeBanner)) throw new AppError(400, "validation_error", "Cannot replace and remove the same image");
    const obsolete = editProfile(viewer.id, { displayName, bio: stringValue(ctx.body, "bio", current.bio).trim(), location: stringValue(ctx.body, "location", current.location).trim(), website,
      avatarMediaId: ctx.body.avatarMediaId as string | undefined, bannerMediaId: ctx.body.bannerMediaId as string | undefined,
      avatarUrl: ctx.body.removeAvatar ? null : undefined, bannerUrl: ctx.body.removeBanner ? null : undefined });
    await removeImages(obsolete); return data(profile(ctx, userByUsername(viewer.username)));
  } },
  { method: "GET", path: "/users/me/blocks", summary: "List accounts you blocked", auth: true, response: "UserListItem", paged: true, handler: ctx => page(usersPage(requiredViewer(ctx).id, pageOptions(ctx), { safety: "block" })) },
  { method: "GET", path: "/users/me/mutes", summary: "List accounts you muted", auth: true, response: "UserListItem", paged: true, handler: ctx => page(usersPage(requiredViewer(ctx).id, pageOptions(ctx), { safety: "mute" })) },
  { method: "GET", path: "/users/suggestions", summary: "Suggest accounts to follow", auth: false, response: "UserListItemArray", query: { limit: {} }, handler: ctx => data(suggestedUsers(pageOptions(ctx).limit, ctx.viewer?.id ?? null)) },
  { method: "GET", path: "/users/by-username/:username", summary: "Look up a profile by username", auth: false, response: "Profile", handler: ctx => data(profile(ctx, userByUsername(ctx.params.username))) },
  { method: "GET", path: "/users", summary: "Search or list people", auth: false, response: "UserListItem", paged: true, query: { q: { maxLength: 100 } }, handler: ctx => page(usersPage(ctx.viewer?.id ?? null, pageOptions(ctx), { q: queryText(ctx, "q", 100) })) },
  { method: "GET", path: "/users/:id", summary: "Look up a profile by ID", auth: false, response: "Profile", handler: ctx => data(profile(ctx, user(ctx))) },
  ...(["followers", "following"] as const).map(direction => ({ method: "GET" as const, path: `/users/:id/${direction}`, summary: `List a user's ${direction}`, auth: false, response: "UserListItem", paged: true, handler(ctx: ApiContext) {
    const target = user(ctx); if (!target) throw new AppError(404, "not_found", "User not found");
    return page(usersPage(ctx.viewer?.id ?? null, pageOptions(ctx), { userId: target.id, direction }));
  } })),
  ...(["PUT", "DELETE"] as const).map(method => ({ method, path: "/users/:id/follow", summary: `${method === "PUT" ? "Follow" : "Unfollow"} an account`, auth: true, response: "Following", handler: (ctx: ApiContext) => data({ following: toggleFollowUser(requiredViewer(ctx).id, ctx.params.id, method === "PUT") }) })),
  ...(["block", "mute"] as const).flatMap(kind => (["PUT", "DELETE"] as const).map(method => ({ method, path: `/users/:id/${kind}`, summary: `${method === "PUT" ? "Set" : "Remove"} an account ${kind}`, auth: true, response: kind === "block" ? "Blocked" : "Muted", handler: (ctx: ApiContext) => data({ [kind === "block" ? "blocked" : "muted"]: setSafety(requiredViewer(ctx).id, ctx.params.id, kind, method === "PUT") }) }))),
  { method: "GET", path: "/users/:id/posts", summary: "Read a profile timeline", auth: false, response: "FeedItem", paged: true, query: { tab: { enum: ["posts", "replies", "media", "likes"] } }, handler(ctx) {
    const target = user(ctx); if (!target) throw new AppError(404, "not_found", "User not found");
    const tab = enumQuery(ctx, "tab", ["posts", "replies", "media", "likes"], "posts");
    const options = pageOptions(ctx); return page(timeline({ kind: "user", username: target.username, tab }, options.cursor, ctx.viewer?.id ?? null, { limit: options.limit, strictCursor: true }));
  } },
  { method: "GET", path: "/timeline", summary: "Read For You or Following", auth: true, response: "FeedItem", paged: true, query: { tab: { enum: ["for-you", "following"] } }, handler(ctx) {
    const options = pageOptions(ctx); return page(timeline({ kind: "home", tab: enumQuery(ctx, "tab", ["for-you", "following"], "for-you") }, options.cursor, requiredViewer(ctx).id, { limit: options.limit, strictCursor: true }));
  } },
  { method: "GET", path: "/posts", summary: "Search posts, hashtags, or mentions", auth: false, response: "FeedItem", paged: true, query: { q: { required: true, maxLength: 500 }, tab: { enum: ["top", "latest", "media"] } }, handler(ctx) {
    const options = pageOptions(ctx); return page(timeline({ kind: "search", q: queryText(ctx, "q", 500, true), tab: enumQuery(ctx, "tab", ["top", "latest", "media"], "latest") }, options.cursor, ctx.viewer?.id ?? null, { limit: options.limit, strictCursor: true }));
  } },
  { method: "POST", path: "/posts", summary: "Publish a post, reply, or quote", auth: true, response: "Post", status: 201, body: {
    content: { type: "string", maxLength: 280 }, replyToId: { ...idField, nullable: true }, quoteId: { ...idField, nullable: true }, mediaIds: { type: "array", maxItems: 4, items: idField },
  }, handler(ctx) {
    const viewer = requiredViewer(ctx), id = insertPost(viewer.id, { content: stringValue(ctx.body, "content"), replyToId: ctx.body.replyToId as string | null | undefined, quoteId: ctx.body.quoteId as string | null | undefined, mediaIds: ctx.body.mediaIds as string[] | undefined });
    return data(postById(id, viewer.id), 201, { Location: `/api/v1/posts/${id}` });
  } },
  { method: "GET", path: "/posts/:id", summary: "Read a post", auth: false, response: "Post", handler: ctx => data(post(ctx)) },
  { method: "DELETE", path: "/posts/:id", summary: "Delete your post", auth: true, response: "Deleted", async handler(ctx) {
    const target = post(ctx), viewer = requiredViewer(ctx);
    if (target.author.id !== viewer.id) throw new AppError(403, "forbidden", "You can only delete your own posts");
    await removeImages(removePost(viewer.id, target.id)); return data({ deleted: true });
  } },
  { method: "GET", path: "/posts/:id/thread", summary: "Read a thread and its ancestors", auth: false, response: "PostThread", handler(ctx) { post(ctx); return data(postThread(ctx.params.id, ctx.viewer?.id ?? null)); } },
  ...(["replies", "quotes"] as const).map(kind => ({ method: "GET" as const, path: `/posts/:id/${kind}`, summary: `List ${kind} of a post`, auth: false, response: "Post", paged: true, handler(ctx: ApiContext) { post(ctx); return page(relatedPostsPage(ctx.params.id, ctx.viewer?.id ?? null, kind, pageOptions(ctx))); } })),
  ...(["likes", "reposts"] as const).map(kind => ({ method: "GET" as const, path: `/posts/:id/${kind}`, summary: `List accounts that ${kind === "likes" ? "liked" : "reposted"} a post`, auth: false, response: "UserListItem", paged: true, handler(ctx: ApiContext) { post(ctx); return page(postUsersPage(ctx.params.id, ctx.viewer?.id ?? null, kind, pageOptions(ctx))); } })),
  ...(["like", "repost", "bookmark"] as const).flatMap(kind => (["PUT", "DELETE"] as const).map(method => ({ method, path: `/posts/:id/${kind}`, summary: `${method === "PUT" ? "Set" : "Remove"} a ${kind}`, auth: true, response: "Interaction", handler(ctx: ApiContext) {
    // Undo remains possible after a block, even though the post is no longer visible.
    if (method === "PUT") post(ctx);
    return data(togglePostInteraction(requiredViewer(ctx).id, ctx.params.id, kind, method === "PUT"));
  } }))),
  { method: "PUT", path: "/posts/:id/not-interested", summary: "Dismiss a recommended post", auth: true, response: "Success", handler(ctx) { post(ctx); saveNotInterested(requiredViewer(ctx).id, ctx.params.id); return data({ success: true }); } },
  { method: "POST", path: "/impressions", summary: "Record seen posts in a batch", auth: true, response: "Success", body: { postIds: { type: "array", required: true, maxItems: 100, items: idField } }, handler(ctx) { saveImpressions(requiredViewer(ctx).id, ctx.body.postIds as string[]); return data({ success: true }); } },
  { method: "GET", path: "/bookmarks", summary: "Read your private bookmarks", auth: true, response: "FeedItem", paged: true, handler(ctx) { const options = pageOptions(ctx); return page(timeline({ kind: "bookmarks" }, options.cursor, requiredViewer(ctx).id, { limit: options.limit, strictCursor: true })); } },
  { method: "GET", path: "/trends", summary: "Read trending hashtags", auth: false, response: "TrendArray", query: { limit: {} }, handler: ctx => data(trends(pageOptions(ctx).limit)) },
  { method: "GET", path: "/notifications", summary: "Read your notifications", auth: true, response: "Notification", paged: true, query: { filter: { enum: ["all", "mentions"] } }, handler: ctx => page(notificationsPage(requiredViewer(ctx).id, pageOptions(ctx), enumQuery(ctx, "filter", ["all", "mentions"], "all") === "mentions")) },
  { method: "GET", path: "/notifications/unread-count", summary: "Count unread notifications", auth: true, response: "UnreadCount", handler: ctx => data({ unreadCount: unreadCount(requiredViewer(ctx).id) }) },
  { method: "PUT", path: "/notifications/read", summary: "Mark all notifications read", auth: true, response: "UnreadCount", handler(ctx) { readNotifications(requiredViewer(ctx).id); return data({ unreadCount: 0 }); } },
  { method: "PUT", path: "/notifications/:id/read", summary: "Mark one notification read", auth: true, response: "Success", handler(ctx) { markNotificationRead(requiredViewer(ctx).id, ctx.params.id); return data({ success: true }); } },
  { method: "POST", path: "/media", summary: "Upload an image using multipart file and purpose", auth: true, response: "Upload", status: 201, async handler(ctx) {
    const type = ctx.request.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data;")) throw new AppError(415, "unsupported_media_type", "Use multipart/form-data with a file field");
    const bytes = await boundedBytes(ctx.request, 5 * 1024 * 1024 + 64 * 1024);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
    catch { throw new AppError(400, "validation_error", "Invalid multipart form"); }
    if (Array.from(form.keys()).some(k => !["file", "purpose"].includes(k)) || form.getAll("file").length !== 1 || form.getAll("purpose").length > 1) throw new AppError(400, "validation_error", "Upload one file and an optional purpose");
    const file = form.get("file"), purpose = form.get("purpose") ?? "post";
    if (!(file instanceof File) || typeof purpose !== "string" || !["post", "avatar", "banner"].includes(purpose)) throw new AppError(400, "validation_error", "Choose a file and purpose: post, avatar, or banner");
    const result = await createUpload(requiredViewer(ctx).id, file, purpose as Upload["purpose"]); return data(result, 201);
  } },
  { method: "GET", path: "/media/:id", summary: "Inspect your uploaded image", auth: true, response: "Upload", handler: ctx => data(uploadById(requiredViewer(ctx).id, ctx.params.id)) },
  { method: "DELETE", path: "/media/:id", summary: "Delete an unattached uploaded image", auth: true, response: "Deleted", async handler(ctx) {
    const url = transaction(() => { const upload = uploadById(requiredViewer(ctx).id, ctx.params.id); if (upload.claimed) throw new AppError(409, "media_unavailable", "Delete the post or replace the profile image to remove attached media"); run("DELETE FROM media_uploads WHERE id=? AND user_id=?", upload.id, requiredViewer(ctx).id); return upload.url; });
    await removeImages([url]); return data({ deleted: true });
  } },
  { method: "GET", path: "/conversations", summary: "Read your direct-message inbox", auth: true, response: "Conversation", paged: true, handler: ctx => page(conversationsFor(requiredViewer(ctx).id, pageOptions(ctx))) },
  { method: "POST", path: "/conversations", summary: "Start or retrieve a one-to-one conversation", auth: true, response: "Conversation", status: 201, body: { recipientId: { ...idField, required: true } }, handler(ctx) {
    const result = createConversation(requiredViewer(ctx).id, stringValue(ctx.body, "recipientId")); return data(result.conversation, result.created ? 201 : 200);
  } },
  { method: "GET", path: "/conversations/unread-count", summary: "Count unread messages across your inbox, excluding blocked and muted accounts", auth: true, response: "UnreadCount", handler: ctx => data({ unreadCount: unreadMessageCount(requiredViewer(ctx).id) }) },
  { method: "GET", path: "/conversations/:id", summary: "Read a conversation", auth: true, response: "Conversation", handler: ctx => data(conversationById(requiredViewer(ctx).id, ctx.params.id)) },
  { method: "GET", path: "/conversations/:id/messages", summary: "Read messages, newest first", auth: true, response: "Message", paged: true, handler: ctx => page(messagesFor(requiredViewer(ctx).id, ctx.params.id, pageOptions(ctx))) },
  { method: "POST", path: "/conversations/:id/messages", summary: "Send a signed end-to-end encrypted direct message; plaintext is rejected", auth: true, response: "Message", status: 201, bodyLimit: 128 * 1024, body: { encryption: { type: "object", required: true, fields: envelopeFields } }, handler: ctx => data(sendMessage(requiredViewer(ctx).id, ctx.params.id, ctx.body.encryption as EncryptedEnvelope), 201) },
  { method: "PUT", path: "/conversations/:id/read", summary: "Mark a conversation read through a message", auth: true, response: "UnreadCount", body: { upToMessageId: idField }, handler: ctx => data({ unreadCount: markConversationRead(requiredViewer(ctx).id, ctx.params.id, ctx.body.upToMessageId as string | undefined) }) },
  { method: "DELETE", path: "/messages/:id", summary: "Delete your own direct message for both participants", auth: true, response: "Deleted", handler(ctx) { deleteMessage(requiredViewer(ctx).id, ctx.params.id); return data({ deleted: true }); } },
];
export { endpoints };

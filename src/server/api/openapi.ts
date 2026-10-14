import "server-only";
import { endpoints } from "./endpoints";
import type { Field, Fields } from "./http";
import { DM_PROTOCOL } from "../../lib/e2ee-contract";

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const bool = { type: "boolean" }, count = { type: "integer", minimum: 0 }, date = str({ format: "date-time" });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const array = (schema: Schema): Schema => ({ type: "array", items: schema });
const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const summaryFields = { id: str(), username: str(), displayName: str(), avatarUrl: nullable(str()), verified: bool };
const listFields = { ...summaryFields, bio: str(), isFollowing: bool, followsYou: bool, isSelf: bool };
export const schemas: Record<string, Schema> = {
  UserSummary: obj(summaryFields),
  UserListItem: obj(listFields),
  Profile: obj({ ...listFields, location: str(), website: str(), bannerUrl: nullable(str()), createdAt: date, followersCount: count, followingCount: count, postsCount: count, isBlocked: bool, isMuted: bool, blockedBy: bool }),
  QuotedPost: obj({ id: str(), author: ref("UserSummary"), content: str(), createdAt: date, imageUrls: array(str()), deleted: bool }),
  Post: obj({ id: str(), author: ref("UserSummary"), content: str(), createdAt: date, imageUrls: array(str()), replyToId: nullable(str()), replyToUsername: nullable(str()), quote: nullable(ref("QuotedPost")), replyCount: count, repostCount: count, likeCount: count, bookmarkCount: count, viewer: obj({ liked: bool, reposted: bool, bookmarked: bool }) }),
  FeedItem: obj({ key: str(), post: ref("Post"), repostedBy: nullable(ref("UserSummary")) }),
  PostThread: obj({ ancestors: array(ref("Post")), post: ref("Post"), replies: array(ref("Post")) }),
  Notification: obj({ id: str(), type: str({ enum: ["like", "repost", "follow", "reply", "mention", "quote"] }), actor: ref("UserSummary"), post: nullable(ref("Post")), createdAt: date, read: bool }),
  Trend: obj({ tag: str(), postCount: count }),
  TrendArray: array(ref("Trend")), UserListItemArray: array(ref("UserListItem")),
  AuthSession: obj({ user: ref("Profile"), accessToken: str(), tokenType: str({ const: "Bearer" }), expiresAt: date }),
  Success: obj({ success: bool }), Deleted: obj({ deleted: bool }), Following: obj({ following: bool }), Blocked: obj({ blocked: bool }), Muted: obj({ muted: bool }),
  Interaction: obj({ active: bool, count }), UnreadCount: obj({ unreadCount: count }),
  EncryptedEnvelope: obj({ version: str({ const: DM_PROTOCOL }), clientId: str({ format: "uuid" }), senderKeyId: str(), recipientKeyId: str(), ephemeralPublicKey: str(), salt: str(), recipientIv: str(), recipientCiphertext: str(), senderIv: str(), senderCiphertext: str(), signature: str() }),
  PublicIdentity: obj({ userId: str(), keyId: str(), encryptionPublicKey: str(), signingPublicKey: str() }),
  PublicIdentityResult: nullable(ref("PublicIdentity")),
  IdentityBackup: obj({ userId: str(), keyId: str(), encryptionPublicKey: str(), signingPublicKey: str(), backupIv: str(), backupCiphertext: str() }),
  IdentityBackupResult: nullable(ref("IdentityBackup")),
  Message: obj({ id: str(), conversationId: str(), sender: ref("UserSummary"), recipientId: str(), encryption: nullable(ref("EncryptedEnvelope")), legacyRemoved: bool, createdAt: date }),
  Conversation: obj({ id: str(), participant: ref("UserSummary"), lastMessage: nullable(ref("Message")), unreadCount: count, blocked: bool, muted: bool, updatedAt: date }),
  Upload: obj({ id: str(), url: str(), type: str(), size: count, purpose: str({ enum: ["post", "avatar", "banner"] }), claimed: bool, createdAt: date }),
  Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: str(), message: str(), details: {} } } } },
};
function requestSchema(fields: Fields): Schema {
  function fieldSchema(field: Field): Schema {
    if (field.type === "object") return requestSchema(field.fields ?? {});
    const schema: Schema = { type: field.type };
    for (const name of ["minLength", "maxLength", "pattern", "enum", "maxItems"] as const) if (field[name] !== undefined) schema[name] = field[name];
    if (field.items) schema.items = fieldSchema(field.items);
    return field.nullable ? nullable(schema) : schema;
  }
  const properties = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, fieldSchema(field)]));
  return { type: "object", additionalProperties: false, properties, required: Object.entries(fields).filter(([, f]) => f.required).map(([key]) => key) };
}
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const path = endpoint.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters: unknown[] = [...endpoint.path.matchAll(/:([A-Za-z]+)/g)].map(m => ({ in: "path", name: m[1], required: true, schema: str({ pattern: m[1] === "username" ? "^[A-Za-z0-9_]{1,15}$" : "^[A-Za-z0-9_-]{1,100}$" }) }));
    if (endpoint.paged || endpoint.query?.limit) parameters.push({ in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } });
    if (endpoint.paged) parameters.push({ in: "query", name: "cursor", description: "Opaque, resource- and viewer-bound cursor. Timeline cursors expire after 24 hours.", schema: str() });
    for (const [name, rule] of Object.entries(endpoint.query ?? {})) if (name !== "limit") parameters.push({ in: "query", name, required: rule.required ?? false, schema: str({ ...(rule.enum ? { enum: rule.enum } : {}), ...(rule.maxLength ? { maxLength: rule.maxLength } : {}) }) });
    const value = endpoint.paged ? obj({ data: array(ref(endpoint.response)), meta: obj({ nextCursor: nullable(str()) }) }) : obj({ data: ref(endpoint.response) });
    const success = { description: "Success", content: { "application/json": { schema: value } } };
    const responses: Record<string, unknown> = { [endpoint.status ?? 200]: success };
    if (endpoint.path === "/conversations" && endpoint.method === "POST") responses[200] = success;
    for (const code of [400, 401, 403, 404, 409, 413, 415, 429, 500]) responses[code] = { description: ({ 400: "Invalid input or cursor", 401: "Authentication required or invalid", 403: "Forbidden", 404: "Not found", 409: "Conflict", 413: "Payload too large", 415: "Unsupported content type", 429: "Rate limited", 500: "Internal server error" })[code], content: { "application/json": { schema: ref("Error") } } };
    const requestBody = endpoint.body ? { required: true, content: { "application/json": { schema: requestSchema(endpoint.body) } } } : endpoint.path === "/media" && endpoint.method === "POST" ? { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, purpose: str({ enum: ["post", "avatar", "banner"], default: "post" }) } } } } } : undefined;
    (paths[path] ??= {})[endpoint.method.toLowerCase()] = {
      summary: endpoint.summary, operationId: `${endpoint.method.toLowerCase()}_${endpoint.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      tags: [endpoint.path.split("/")[1]], security: endpoint.auth ? [{ bearerAuth: [] }, { cookieAuth: [] }] : [{}, { bearerAuth: [] }, { cookieAuth: [] }],
      parameters, ...(requestBody ? { requestBody } : {}), responses,
    };
  }
  return {
    openapi: "3.1.0", info: { title: "Elytra API", version: "1.0.0", description: "Twitter-style social API. All operations share the website's SQLite data. Uses session bearer tokens or the elytra_session cookie; cookie mutations must be same-origin. No OAuth or streaming transport." },
    servers: [{ url: "/api/v1" }], paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "accessToken returned by login or register; expires after 30 days" }, cookieAuth: { type: "apiKey", in: "cookie", name: "elytra_session" } }, schemas },
  };
}

# Elytra REST API

Base URL: `/api/v1`. Discover operations with `GET /api/v1`; import `GET /api/v1/openapi.json` into an OpenAPI 3.1 client for request and response schemas. `GET /api/v1/health` checks the database connection.

The API uses the same database, sessions, notifications, and feed ranking as the website. No external services or new packages are needed. Database tables and indexes migrate additively on startup, preserving existing accounts and posts.

## Authentication

`POST /auth/register` accepts `username`, `displayName`, and `password`. `POST /auth/login` accepts `username` and `password`. Both return:

```json
{
  "data": {
    "user": { "id": "…", "username": "demo", "displayName": "Demo User", "…": "profile fields" },
    "accessToken": "64-character session token",
    "tokenType": "Bearer",
    "expiresAt": "2026-11-13T12:00:00.000Z"
  }
}
```

Send `Authorization: Bearer <accessToken>` from native or server clients. Login also sets the website's `elytra_session` cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` in production); same-origin browser clients can use that cookie. Tokens expire after 30 days, and only their SHA-256 hashes are stored. An explicit invalid bearer token returns 401 even if a valid cookie is also present.

`POST /auth/logout` revokes the current token and clears the cookie. `DELETE /auth/sessions` revokes all sessions for the authenticated account. Usernames are case-insensitive, 3–15 letters, digits, or underscores; app route names including `messages` are reserved. Passwords are 8–1,024 characters.

Cookie-authenticated mutations reject a mismatched `Origin` or cross-site `Sec-Fetch-Site`. JSON operations require `Content-Type: application/json`. For a reverse proxy whose internal request URL differs from the browser URL, set `ELYTRA_PUBLIC_ORIGIN` to the exact public origin, such as `https://elytra.example`. No cross-origin browser access is enabled. Bearer clients do not need an Origin header.

```sh
curl http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"password123"}'

# Replace TOKEN with accessToken from the login response.
curl http://localhost:3000/api/v1/posts \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"content":"Hello Elytra #firstpost"}'
```

## Responses and pagination

Single resources and mutations return `{ "data": … }`. Collections return `{ "data": […], "meta": { "nextCursor": "…" } }`. Pass `limit=1..100` (default 20) and the opaque `cursor` to load more. Stop when `nextCursor` is null. Keep the same account and filters when continuing a cursor.

Feeds use frozen snapshots so posts, likes, and reposts added after page one do not shift subsequent pages. Feed cursors expire after 24 hours. Removed activity, dismissed posts, blocks, and mutes take effect on existing snapshots. Other collections use keyset pagination: inbox activity can move a conversation into a newer page, so clients should deduplicate conversation IDs when polling. People lists sort by username; notifications and related posts sort newest first. Messages sort by insertion sequence, newest first, with strictly increasing timestamps within a conversation.

Dates are UTC ISO 8601 strings. Resource IDs are opaque strings. Errors return:

```json
{ "error": { "code": "validation_error", "message": "Invalid request fields", "details": { "content": "Length must be 0–280" } } }
```

Status codes: 400 for invalid input/cursors, 401 for missing or invalid authentication, 403 for forbidden operations, 404 for missing or inaccessible resources, 405 for an unsupported method, 409 for conflicts, 413 for oversized bodies, 415 for unsupported content types, and 429 for rate limits. Server failures use a generic 500 message; `X-Request-Id` correlates it with server logs. All responses use `Cache-Control: no-store`. HEAD and OPTIONS are supported.

Unknown JSON fields, unknown query parameters, duplicate query parameters, wrong types, and invalid IDs are rejected. JSON bodies are limited to 64 KiB, except encrypted-message requests (128 KiB for two encrypted copies). Character limits count Unicode code points for posts and messages, including emoji.

## Posts and feeds

- `GET /timeline?tab=for-you|following`: authenticated home feed. For You shares the website's recommendation model; Following is chronological.
- `GET /posts?q=…&tab=top|latest|media`: public search; `q` is required, up to 500 characters. `#tag` and `@username` searches use indexed tags and mentions.
- `POST /posts`: authenticated creation. Fields: optional `content` (280 characters), `replyToId`, `quoteId`, `mediaIds` (up to four). A post needs content, images, or a quote.
- `GET /posts/:id`: a post with its author, images, optional quote/parent, counts, and viewer interaction flags.
- `DELETE /posts/:id`: author only. Removes activity and images; replies survive and quotes become tombstones.
- `GET /posts/:id/thread`: ancestors, target, and immediate replies. For large conversations, page replies separately.
- `GET /posts/:id/replies`, `/quotes`: paginated related posts.
- `GET /posts/:id/likes`, `/reposts`: paginated accounts that interacted. Bookmark owners are private.
- `PUT /posts/:id/like`, `/repost`, `/bookmark`: set the interaction. `DELETE` removes it. These are idempotent and return `{active, count}`; repeated requests do not toggle or duplicate notifications.
- `GET /bookmarks`: authenticated private bookmark feed.
- `PUT /posts/:id/not-interested`: dismiss a recommendation and update author preference signals.
- `POST /impressions` with `{postIds: […]}`: record up to 100 seen posts. Duplicate IDs are deduplicated; removed posts are ignored.
- `GET /trends?limit=…`: hashtag counts, preferring the last seven days, with an all-time fallback.

## People and profiles

- `GET /users?q=…`: paginated people search (optional query, up to 100 characters).
- `GET /users/suggestions?limit=…`: follow suggestions.
- `GET /users/:id`, `/users/by-username/:username`: public profile, follower/following/post counts, viewer follow flags, and `isBlocked`, `blockedBy`, `isMuted`.
- `GET /users/me`: authenticated profile.
- `PATCH /users/me`: partial edit. Fields: `displayName` (1–50), `bio` (160), `location` (30), `website` (100, http/https), `avatarMediaId`, `bannerMediaId`, `removeAvatar`, `removeBanner`. Unspecified fields keep their current values.
- `GET /users/:id/posts?tab=posts|replies|media|likes`: profile feed. Replies follows the existing website's tab behavior and includes all authored posts.
- `GET /users/:id/followers`, `/following`: paginated connections.
- `PUT /users/:id/follow`, `DELETE /users/:id/follow`: idempotent follow/unfollow, returning `{following}`.

## Images

`POST /media` requires authentication and multipart form fields `file` and optional `purpose` (`post`, `avatar`, `banner`; default `post`). Accepts PNG, JPEG, GIF, or WebP, 1 byte to 5 MiB; MIME type and signature must match. The multipart body itself is limited to 5 MiB plus 64 KiB of overhead.

The response contains `{id, url, type, size, purpose, claimed, createdAt}`. Use the ID in `POST /posts` or `PATCH /users/me`. Uploads belong to their uploader and can only be claimed once, for their declared purpose. Claims and resource writes are transactional; a failed post or profile edit leaves the upload available. Arbitrary image URLs are not accepted by the API.

```sh
curl http://localhost:3000/api/v1/media \
  -H 'Authorization: Bearer TOKEN' \
  -F 'file=@photo.png' -F 'purpose=post'

# Then post with the returned media ID:
curl http://localhost:3000/api/v1/posts \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"content":"A photo","mediaIds":["MEDIA_ID"]}'
```

`GET /media/:id` inspects your upload. `DELETE /media/:id` removes an unattached upload and its file; attached uploads return 409. Delete the owning post or replace/remove the profile image to remove attached files. Delete abandoned pending uploads explicitly; there is no scheduled upload expiry. Image bytes remain at the existing public `/api/media/:filename` route, with immutable caching.

## Notifications

- `GET /notifications?filter=all|mentions`: authenticated, paginated. Mentions includes mentions and replies.
- `GET /notifications/unread-count`: `{unreadCount}`.
- `PUT /notifications/read`: mark all read.
- `PUT /notifications/:id/read`: mark your notification read. Other users' IDs return 404.

## Direct messages

The UI is at `/messages`, where users generate keys and save a separate recovery code. A new browser must restore the same keys; no key-reset or plaintext fallback exists. Key endpoints require authentication:

- `PUT /users/me/encryption-keys`: publish `{keyId, encryptionPublicKey, signingPublicKey, backupIv, backupCiphertext, proof}`. Public keys are canonical P-256 SPKI DER, encoded as unpadded base64url. The proof signs the account-bound registration, and keys are immutable. Replacing an existing identity/backup returns 409.
- `GET /users/:id/encryption-keys`: `{userId, keyId, encryptionPublicKey, signingPublicKey}`, or null if not enabled. No private-key backup is returned here.
- `GET /users/me/encryption-backup`: your public identity plus `{backupIv, backupCiphertext}`, or null. Decrypt it on the device with the independent recovery code, never on the server.

Messaging endpoints also require authentication:

- `GET /conversations`: paginated inbox, newest activity first.
- `POST /conversations` with `{recipientId}`: create a one-to-one conversation (201), or retrieve the existing conversation (200). Conversation uniqueness is symmetric: both participants get the same ID.
- `GET /conversations/unread-count`: unread message count across the whole inbox, excluding blocked/muted senders.
- `GET /conversations/:id`: participant summary, last message, unread count, blocked/muted flags, and activity timestamp.
- `GET /conversations/:id/messages`: paginated messages, newest first.
- `POST /conversations/:id/messages` with `{encryption: …}`: send a signed E2EE envelope (201). The plaintext `{content}` contract is rejected. The browser encrypts 1–10,000 characters locally; the server bounds ciphertext sizes and verifies the signature. Identical signed retries with the same client ID return the original message without duplication.
- `PUT /conversations/:id/read` with `{upToMessageId}`: mark read through a message you have fetched. The marker never moves backwards. Omitting the ID marks all messages currently present; provide an ID to avoid marking a concurrently arriving message read.
- `DELETE /messages/:id`: sender-only removal for both participants.

Only the two participants can read, send, or mark read. Nonparticipants receive 404, concealing whether the conversation/message exists. A participant attempting to delete the other person's message gets 403. Existing history remains readable after a block; new conversations and sends are forbidden in either direction. The UI polls rather than using a streaming connection.

Messages are **end-to-end encrypted** on devices using P-256 ECDH, HKDF-SHA-256, AES-256-GCM, and ECDSA signatures. The server stores ciphertext and an encrypted key backup; it never receives message text, private keys, or the recovery code. Both participants must first publish their messaging identities. See [E2EE protocol and recovery](E2EE.md). HTTPS is still required in deployment. The API supports one-to-one text messages; group chats, attachments, typing indicators, delivered receipts, and push delivery are outside this version.

## Blocking and muting

`PUT /users/:id/block` / `DELETE /users/:id/block` return `{blocked}`. Blocks remove follows and notifications in both directions, prevent follows, post interactions, replies, quotes, and messages, and hide either participant's posts from the other. Quoted blocked posts render as unavailable tombstones. Public profile metadata stays accessible. Unblocking does not restore follows.

`PUT /users/:id/mute` / `DELETE /users/:id/mute` return `{muted}`. Mutes are viewer-only: home and search feeds and notifications hide that account; notification delivery and the message badge suppress muted senders. Explicit profile/post reads, saved bookmarks, and messaging remain available.

`GET /users/me/blocks` and `/users/me/mutes` are private paginated management lists. Blocking/muting yourself returns 400. All relationship mutations are idempotent.

## Rate limits and configuration

SQLite-backed fixed-window quotas survive server restarts and are shared across workers using the same database:

- Authenticated: 600 reads and 120 mutations per account per minute.
- Anonymous: 600 reads and 60 mutations per minute, shared across anonymous callers.
- Login: 60 attempts per minute globally, plus 10 per username per 15 minutes (successful logins count).
- Registration: 20 requests per hour globally.

Responses include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` (Unix seconds) for the general quota. On 429, use `Retry-After` in seconds. Login/registration quotas may be stricter than the general quota. Anonymous limits intentionally do not trust spoofable forwarded IP headers.

`ELYTRA_DB_PATH` selects the SQLite database (default `data/elytra.db`); `ELYTRA_UPLOAD_DIR` selects uploads (default `data/uploads`); `ELYTRA_PUBLIC_ORIGIN` configures cookie mutation origin checks behind a proxy. The API uses the Node.js runtime and persistent local storage, like the website. Sessions are first-party session tokens, not OAuth access tokens. Lists, OAuth apps, protected accounts, password resets, and streaming APIs are not implemented.

Run `npm run test:api` for all 59 operations, schema validation, access checks, cursors, blocking/muting, media ownership/rollback/cleanup, rate limits, and migrations. Tests use an in-memory database and a temporary upload directory. `npm run test:backend` checks existing backend behavior and recommendation performance. `npm run test:e2ee` checks sender/recipient decryption, signature and ciphertext tampering, recovery, Unicode bounds, and removal of legacy bodies from database/WAL files.

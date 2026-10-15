# Elytra REST API

The base URL is `/api/v1`.

- `GET /api/v1` lists the operations.
- `GET /api/v1/openapi.json` is an OpenAPI 3.1 document with request and response schemas. Import it into a client generator.
- `GET /api/v1/health` checks the database connection; `/api/v1/health/live` checks process liveness. Both bypass rate limits and admission budgets.

The API shares the website's database, sessions, notifications, and feed ranking. It needs no external services or new packages. Tables and indexes migrate additively on startup, so existing accounts and posts survive.

## Authentication

`POST /auth/register` takes `username`, `displayName`, and `password`. `POST /auth/login` takes `username` and `password`. Both return:

```json
{
  "data": {
    "user": { "id": "...", "username": "demo", "displayName": "Demo User", "...": "profile fields" },
    "accessToken": "64-character session token",
    "tokenType": "Bearer",
    "expiresAt": "2026-11-13T12:00:00.000Z"
  }
}
```

Native and server clients send `Authorization: Bearer <accessToken>`. Login also sets the website's `elytra_session` cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` in production), which same-origin browser clients can use. If a request carries an invalid bearer token, it gets 401 even when it also carries a valid cookie.

Tokens expire after 30 days. The server stores only their SHA-256 hashes.

`POST /auth/logout` revokes the current token and clears the cookie. `DELETE /auth/sessions` revokes every session for the authenticated account.

Usernames are case-insensitive and have 3 to 15 letters, digits, or underscores. App route names such as `messages` are reserved. Passwords have 8 to 1,024 characters.

### Cookie requests and proxies

A cookie-authenticated write fails if its `Origin` doesn't match, or if `Sec-Fetch-Site` is cross-site. Bearer clients don't need an `Origin` header. The API enables no cross-origin browser access.

JSON operations require `Content-Type: application/json`.

Behind a reverse proxy, the internal request URL can differ from the URL in the browser. In that case, set `ELYTRA_PUBLIC_ORIGIN` to the exact public origin, such as `https://elytra.example`.

### Example

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

A single resource or a mutation returns `{ "data": ... }`. A collection returns:

```json
{ "data": [], "meta": { "nextCursor": "..." } }
```

Pass `limit` (1 to 100, default 20) and the opaque `cursor` to load more. Stop when `nextCursor` is null. When you continue a cursor, use the same account and filters.

### How pages stay stable

Feeds use frozen snapshots. Posts, likes, and reposts added after page one don't shift later pages. Feeds retain at most 1,000 events by default. Cursors expire after at most 24 hours and can be evicted earlier when an account exceeds its 32-snapshot retention budget across sources. Identical refreshes reuse the latest snapshot. Start a fresh feed after `invalid_cursor`. Removed activity, dismissed posts, blocks, and mutes still apply to an existing snapshot.

Other collections use keyset pagination:

- Inbox activity can move a conversation onto a newer page, so deduplicate conversation IDs when you poll.
- People lists sort by username.
- Notifications and related posts sort newest first.
- Messages sort newest first by insertion sequence. Timestamps within a conversation strictly increase.

### Formats and errors

Dates are UTC ISO 8601 strings. Resource IDs are opaque strings. An error looks like this:

```json
{ "error": { "code": "validation_error", "message": "Invalid request fields", "details": { "content": "Length must be 0 to 280" } } }
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid input or cursor |
| 401 | Missing or invalid authentication |
| 403 | Forbidden operation |
| 404 | Missing or inaccessible resource |
| 405 | Unsupported method |
| 409 | Conflict |
| 408 | Request body timed out or was aborted |
| 413 | Body too large |
| 415 | Unsupported content type |
| 429 | Rate limited |
| 503 | Capacity exhausted or database busy; honor `Retry-After` |

A server failure returns a generic 500 message. The `X-Request-Id` header lets you find the matching entry in the server logs. Every response sets `Cache-Control: no-store`. Normal API responses also include application duration in `Server-Timing`. HEAD and OPTIONS work.

### Strict validation

The API rejects unknown JSON fields, unknown or duplicate query parameters, wrong types, and invalid IDs.

JSON bodies can be up to 64 KiB. Encrypted-message requests can be up to 128 KiB, enough for two encrypted copies. Character limits for posts and messages count Unicode code points, so an emoji counts as one.

## Posts and feeds

- `GET /timeline?tab=for-you|following` returns the authenticated home feed. For You uses the website's recommendation model. Following is chronological.
- `GET /posts?q=...&tab=top|latest|media` searches public posts. `q` is required and has at most 500 characters. Searches for `#tag` and `@username` use indexed tags and mentions.
- `POST /posts` creates a post. All fields are optional: `content` (280 characters), `replyToId`, `quoteId`, and `mediaIds` (up to four). A post needs content, images, or a quote.
- `GET /posts/:id` returns a post with its author, images, optional quote or parent, counts, and the viewer's interaction flags.
- `DELETE /posts/:id` is for the author only. It removes the post's activity and images. Replies stay, and quotes of the post become tombstones.
- `GET /posts/:id/thread` returns up to 100 ancestors, the target post, and up to 100 immediate replies. For a large conversation, page the replies separately.
- `GET /posts/:id/replies` and `GET /posts/:id/quotes` return paginated related posts.
- `GET /posts/:id/likes` and `GET /posts/:id/reposts` return paginated accounts that interacted. Bookmark owners are private.
- `PUT /posts/:id/like`, `PUT /posts/:id/repost`, and `PUT /posts/:id/bookmark` set the interaction. `DELETE` on the same path removes it. These calls are idempotent and return `{active, count}`. A repeated request doesn't toggle the state or send a second notification.
- `GET /bookmarks` returns your private bookmark feed.
- `PUT /posts/:id/not-interested` dismisses a recommendation and updates your preference signals for that author.
- `POST /impressions` with `{postIds: [...]}` records up to 100 seen posts. It deduplicates IDs and ignores removed posts.
- `GET /trends?limit=...` returns hashtag counts. It prefers the last seven days and falls back to all time.

## People and profiles

- `GET /users?q=...` searches people with pagination. The optional query has at most 100 characters.
- `GET /users/suggestions?limit=...` returns follow suggestions.
- `GET /users/:id` and `GET /users/by-username/:username` return a public profile with follower, following, and post counts, the viewer's follow flags, and `isBlocked`, `blockedBy`, and `isMuted`.
- `GET /users/me` returns your profile.
- `PATCH /users/me` edits your profile. Fields you omit keep their values. The fields are:
  - `displayName` (1 to 50 characters)
  - `bio` (160)
  - `location` (30)
  - `website` (100, http or https)
  - `avatarMediaId` and `bannerMediaId`
  - `removeAvatar` and `removeBanner`
- `GET /users/:id/posts?tab=posts|replies|media|likes` returns a profile feed. The replies tab matches the website and includes all of the user's posts.
- `GET /users/:id/followers` and `GET /users/:id/following` return paginated connections.
- `PUT /users/:id/follow` and `DELETE /users/:id/follow` follow and unfollow idempotently. They return `{following}`.

## Images

`POST /media` requires authentication and takes multipart form fields `file` and `purpose`. The `purpose` is optional and can be `post`, `avatar`, or `banner` (default `post`).

- The file must be PNG, JPEG, GIF, or WebP, from 1 byte to 5 MiB. The MIME type and the file signature must agree.
- The whole multipart body is limited to 5 MiB plus 64 KiB of overhead.

The response is `{id, url, type, size, purpose, claimed, createdAt}`. Pass the ID to `POST /posts` or `PATCH /users/me`.

An upload belongs to the user who made it, and it can be claimed once, for its declared purpose. Claims and resource writes are transactional, so a failed post or profile edit leaves the upload available. The API doesn't accept arbitrary image URLs.

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

`GET /media/:id` shows one of your uploads. `DELETE /media/:id` removes an unattached upload and its file. It returns 409 for an attached upload. To remove an attached file, delete the owning post or replace or remove the profile image.

Uploads never expire on a schedule, so delete abandoned ones yourself. The image bytes are served from the public `/api/media/:filename` route with immutable caching.

## Notifications

- `GET /notifications?filter=all|mentions` returns paginated notifications. The `mentions` filter includes mentions and replies.
- `GET /notifications/unread-count` returns `{unreadCount}`.
- `PUT /notifications/read` marks all notifications read.
- `PUT /notifications/:id/read` marks one of your notifications read. Another user's ID returns 404.

## Direct messages

The UI is at `/messages`. There, users generate keys and save a separate recovery code. A new browser must restore the same keys. There is no key reset and no plaintext fallback.

### Encryption keys

These endpoints require authentication.

- `PUT /users/me/encryption-keys` publishes `{keyId, encryptionPublicKey, signingPublicKey, backupIv, backupCiphertext, proof}`.
  - Public keys are canonical P-256 SPKI DER, encoded as unpadded base64url.
  - The proof signs the account-bound registration.
  - Keys can't be changed. Replacing an existing identity or backup returns 409.
- `GET /users/:id/encryption-keys` returns `{userId, keyId, encryptionPublicKey, signingPublicKey}`, or null if the user hasn't enabled messaging. It never returns the private-key backup.
- `GET /users/me/encryption-backup` returns your public identity plus `{backupIv, backupCiphertext}`, or null. Decrypt the backup on the device with the independent recovery code, never on the server.

### Conversations and messages

These endpoints also require authentication.

- `GET /conversations` returns the paginated inbox, newest activity first.
- `POST /conversations` with `{recipientId}` creates a one-to-one conversation and returns 201. If one exists, it returns that conversation with 200. Both participants get the same conversation ID.
- `GET /conversations/unread-count` returns the unread message count across the inbox, excluding blocked and muted senders.
- `GET /conversations/:id` returns the participant summary, last message, unread count, blocked and muted flags, and activity timestamp.
- `GET /conversations/:id/messages` returns paginated messages, newest first.
- `POST /conversations/:id/messages` with `{encryption: ...}` sends a signed E2EE envelope and returns 201.
  - The server rejects the plaintext `{content}` form.
  - The browser encrypts 1 to 10,000 characters locally. The server bounds the ciphertext sizes and verifies the signature.
  - Retrying an identical signed message with the same client ID returns the original message and creates no duplicate.
- `PUT /conversations/:id/read` with `{upToMessageId}` marks messages read through a message you have fetched. The marker never moves backwards. If you omit the ID, the server marks every message present at that moment. Send an ID to avoid marking a message that arrives concurrently.
- `DELETE /messages/:id` is for the sender only and removes the message for both participants.

Only the two participants can read, send, or mark messages read. Anyone else gets 404, which hides whether the conversation or message exists. A participant who tries to delete the other person's message gets 403.

After a block, existing history stays readable, but new conversations and new messages are forbidden in both directions. The UI polls for updates. There is no streaming connection.

### Encryption summary

Messages are end-to-end encrypted on the devices with P-256 ECDH, HKDF-SHA-256, AES-256-GCM, and ECDSA signatures. The server stores ciphertext and an encrypted key backup. It never receives message text, private keys, or the recovery code. Both participants must publish their messaging identities first. Deployments still need HTTPS. See [E2EE protocol and recovery](E2EE.md).

The API supports one-to-one text messages only. It has no group chats, attachments, typing indicators, delivery receipts, or push delivery.

## Blocking and muting

`PUT /users/:id/block` and `DELETE /users/:id/block` return `{blocked}`.

A block:

- removes follows and notifications in both directions
- prevents follows, post interactions, replies, quotes, and messages
- hides each person's posts from the other
- shows quoted blocked posts as unavailable tombstones

Public profile metadata stays accessible. Unblocking doesn't restore follows.

`PUT /users/:id/mute` and `DELETE /users/:id/mute` return `{muted}`. A mute applies to the viewer only. It hides the account from home feeds, search feeds, and notifications, and it stops notification delivery and the message badge for that sender. You can still read the account's profile and posts directly, keep its saved bookmarks, and message it.

`GET /users/me/blocks` and `GET /users/me/mutes` return your private, paginated management lists. Blocking or muting yourself returns 400. All relationship changes are idempotent.

## Rate limits and configuration

Quotas use fixed windows stored in SQLite. They survive restarts and are shared by all workers that use the same database.

| Scope | Limit |
| --- | --- |
| Authenticated reads | 600 per account per minute |
| Authenticated mutations | 120 per account per minute |
| Anonymous reads | 600 per trusted client identity per minute |
| Anonymous mutations | 60 per trusted client identity per minute |
| Login | 60 attempts per client per minute, and 10 per username per 15 minutes (successful logins count) |
| Registration | 20 requests per client per hour |

Responses include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` (Unix seconds) for the general quota. Login and registration quotas can be stricter than the general one. On a 429, wait the number of seconds in `Retry-After`. Forwarded identity is ignored unless `ELYTRA_TRUSTED_IP_HEADER` explicitly names a header overwritten by a trusted ingress. Without that configuration, anonymous callers share one bucket. See [backend operations](BACKEND.md) for the ingress boundary, capacity budgets, request deadlines, and load testing.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ELYTRA_DB_PATH` | SQLite database file | `data/elytra.db` |
| `ELYTRA_UPLOAD_DIR` | Upload directory | `data/uploads` |
| `ELYTRA_PUBLIC_ORIGIN` | Public origin for cookie write checks behind a proxy | unset |
| `ELYTRA_TRUSTED_IP_HEADER` | Trusted, overwritten ingress header for anonymous quotas | unset |

Like the website, the API runs on the Node.js runtime and needs persistent local storage.

Sessions are first-party tokens, not OAuth access tokens. The API has no lists, OAuth apps, protected accounts, password resets, or streaming.

## Tests

- `npm run test:api` covers all 59 operations, schema validation, access checks, cursors, blocking and muting, media ownership, rollback and cleanup, rate limits, and migrations. It uses an in-memory database and a temporary upload directory.
- `npm run test:backend` checks existing backend behavior and recommendation performance.
- `npm run test:e2ee` checks sender and recipient decryption, signature and ciphertext tampering, recovery, Unicode bounds, and removal of legacy bodies from the database and WAL files.

- `npm run test:concurrency` checks capacity recovery, deadlines, competing writers, bounded retention, counter consistency, and streaming with isolated files.

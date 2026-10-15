# Backend concurrency and operations

Elytra keeps its dependency-free Node/SQLite deployment. This backend reduces work per request, bounds expensive concurrency, and returns retryable errors when capacity is exhausted. The website and REST API use the same data layer; no frontend migration is required.

This is a **single-host, single-app-process architecture**, not a distributed database. SQLite calls still execute synchronously on Node's request thread. The number of simultaneous users you can support depends on request frequency, query mix, dataset, CPU, disk latency, and upload traffic. A concurrency setting is a resource budget, not a throughput promise. Measure on your deployment before advertising a capacity number.

## Request and storage behavior

- Password hashing/verification uses asynchronous `crypto.scrypt` with the existing salt/hash format and cost. A process-wide capacity gate allows two active KDF operations and 32 queued operations by default; queued work expires after two seconds. Normal authentication paths never use `scryptSync`. The synchronous helper is confined to demo initialization/seeding, which is disabled in production. This leaves the event loop free and reserves some of Node's default worker pool for filesystem work.
- The REST dispatcher compiles route patterns once and serializes the OpenAPI contract once. It admits at most 128 requests concurrently, with a separate eight-upload budget reserved **before** multipart buffering. Full budgets immediately return `503 overloaded` and `Retry-After: 1`. Capacity is released on both successful and failed requests. Server Action image processing shares the upload budget; Next has already parsed those action bodies, so ingress limits remain necessary.
- Body readers enforce both byte limits and a 15-second total read deadline, including bodies sent without `Content-Length`. Client aborts and deadlines cancel the reader. Oversized input returns 413; stalled/aborted bodies return 408. These deadlines cannot interrupt synchronous SQL or CPU work.
- SQLite uses WAL, foreign keys, full synchronous durability, secure deletion, a 16 MiB page-cache target, and a 250 ms busy timeout. The short busy timeout bounds a competing writer's event-loop stall; SQLite busy/locked errors become `503 database_busy` with `Retry-After`. Do not raise it casually: it is a synchronous wait.
- A connection-local LRU retains at most 512 prepared statements. There is no cross-user rendered-response or session cache, so session revocations, blocks, mutes, and interaction changes remain authoritative. Transactions support nested savepoints, roll back on errors, and must contain only synchronous work. Never `await` inside a transaction callback.
- Engagement counts live in `post_stats`. SQLite triggers update them atomically for every post, like, repost, bookmark, reply, and cascading deletion, including writes from scripts. Hydration reads counters and indexed viewer flags instead of scanning all interactions on a popular post. Existing installations get a one-time transactional backfill, recorded in `backend_migrations`. Do not bypass the triggers or manually edit the counters.
- Added indexes support session revocation, notification identity/unread/page lookups, interaction histories, author feeds, and snapshot retention. DM page hydration batches conversation and sender lookups instead of making those queries for every message. Inbox hydration batches participants, last messages, safety flags, and unread counts.
- Timeline snapshots contain at most 1,000 events. Identical refreshes reuse the latest unexpired snapshot rather than storing the same JSON again. Each viewer retains at most 32 snapshots across sources; unauthenticated feeds share one retention budget. A snapshot lasts **up to** 24 hours and can be evicted sooner by that budget. Continuation reads check expiry explicitly and do not acquire an immediate write transaction. New snapshots hold a short transaction only for insertion/pruning. Blocks, mutes, unfollows, dismissals, and removed events are still checked while paging.
- Cold-start popularity and affinity ranking consider the newest eligible 1,000 posts before selecting its ranked pool, using stored engagement counts. Network graph retrieval pushes actor filters into each interaction source; reciprocal features use post-directed indexes. Author features sum stored counters for recent posts. Other recommendation pools retain their independent caps. A bounded result size does not guarantee bounded SQL execution time: substring search, graph traversal, ranking, trends, suggestions, and very large unread histories can still be expensive.
- Unpaged thread payloads contain at most 100 ancestors and 100 direct replies. The legacy website connection-list query returns at most 100 people. Complete reply and follower/following browsing is available through the existing cursor-paginated REST operations. These are deliberate response-size limits; the current website does not add pagination controls for those legacy lists.
- Expiry cleanup runs lazily at most once per second per module instance, deleting at most 500 rows from each of sessions, rate limits, and timeline snapshots. It catches up in small batches under traffic instead of sweeping entire tables on every login/read. Cursor/session/rate-window expiry is enforced independently of physical deletion. Idle databases need no timer to keep the process awake; their expired rows are reclaimed when traffic resumes. Retention caps bound new per-viewer snapshot growth, but old installations with a backlog may need maintenance time to drain it.
- Images stream from disk in 64 KiB chunks with a separate 64-stream budget, content length, immutable cache headers, ETags, HEAD, and conditional 304 responses. Stream consumption, cancellation, and errors close the descriptor and release its slot. There is no in-process cache of complete image files.

## Configuration

All numeric settings are validated as integers when the backend initializes. Restart after changing them. Gates are shared through process state across separately loaded Next route/action bundles; separate processes have separate budgets.

| Variable | Default | Allowed range | Purpose |
| --- | ---: | ---: | --- |
| `ELYTRA_API_CONCURRENCY` | 128 | 1–4096 | Admitted REST requests |
| `ELYTRA_UPLOAD_CONCURRENCY` | 8 | 1–128 | Multipart requests and action image work |
| `ELYTRA_MEDIA_CONCURRENCY` | 64 | 1–1024 | Open media streams |
| `ELYTRA_PASSWORD_CONCURRENCY` | 2 | 1–32 | Active scrypt operations |
| `ELYTRA_PASSWORD_QUEUE` | 32 | 0–1024 | Waiting password operations |
| `ELYTRA_PASSWORD_WAIT_MS` | 2000 | 1–30000 | Maximum KDF queue wait |
| `ELYTRA_BODY_TIMEOUT_MS` | 15000 | 10–120000 | Total API body-read deadline |
| `ELYTRA_DB_BUSY_TIMEOUT_MS` | 250 | 0–5000 | Synchronous database lock wait |
| `ELYTRA_STATEMENT_CACHE_SIZE` | 512 | 0–4096 | Retained statements; zero disables caching |
| `ELYTRA_SNAPSHOT_ENTRIES` | 1000 | 100–10000 | Events retained in one feed snapshot and cold-start candidate window |
| `ELYTRA_SNAPSHOTS_PER_VIEWER` | 32 | 1–256 | Retained snapshots per viewer, across sources |
| `ELYTRA_LOG_REQUESTS` | unset | `true` enables | JSON API completion logs |
| `ELYTRA_TRUSTED_IP_HEADER` | unset | See below | Source of anonymous client rate-limit identity |

Existing `ELYTRA_DB_PATH`, `ELYTRA_UPLOAD_DIR`, `ELYTRA_SEED_DEMO`, and `ELYTRA_PUBLIC_ORIGIN` settings still apply. Numeric environment settings must also be passed into the app container if you override the supplied Compose defaults; shell `.env` entries alone are not automatically container environment variables.

Node's asynchronous scrypt uses its worker pool and memory. Keep password concurrency below `UV_THREADPOOL_SIZE` (normally four) with headroom for filesystem work. If you change that pool size, set it before Node starts, then load-test CPU, memory, and login latency. Raising the queue usually increases waiting and retained passwords in memory rather than throughput.

### Rate limits and the ingress boundary

Rate counters persist in SQLite and use one atomic UPSERT/RETURNING operation. Expired windows reset in that operation even if cleanup has not run. Authenticated clients get their own account buckets: 600 reads/minute and 120 mutations/minute. Anonymous clients get 600 reads/minute and 60 mutations/minute per trusted ingress identity. Login adds 60 attempts/minute/client and 10 attempts/15 minutes/username; registration adds 20/hour/client. The same login/registration protections apply to Server Actions.

The app intentionally ignores forwarded IP headers by default. Without an explicitly trusted ingress header, anonymous clients share the `untrusted` bucket. Logged-in accounts still have separate buckets. Configure identity before a public launch so visitors do not consume a shared login/registration quota:

- The supplied Cloudflare Tunnel Compose setup sets `ELYTRA_TRUSTED_IP_HEADER=cf-connecting-ip`. Its app port is private to the Compose network. Keep the tunnel as the only ingress that can reach it.
- With another trusted proxy, set `ELYTRA_TRUSTED_IP_HEADER=x-real-ip` or `x-forwarded-for`. The app uses the first IP from the selected header. Configure the proxy to **overwrite** that header with the actual source address; do not append to client-supplied values. Block direct access to the origin.

Forwarded identity is only trustworthy at that network boundary. A directly reachable origin lets clients forge identities. Also configure connection limits, body-size limits, header/body timeouts, TLS, and abuse controls at ingress. The 21 MiB Server Action body limit remains in Next configuration; the API upload limit is 5 MiB plus multipart overhead. API gates do not bound SSR rendering, Next's pre-dispatch body parsing, idle sockets, or every query from a Server Action.

Clients should honor `Retry-After` on 429/503 and retry with jitter and a bounded attempt count. Replay idempotent PUT/DELETE operations freely; do not blindly retry a post creation or registration after an ambiguous network failure. DM sends retain their encrypted `clientId` idempotency contract.

## Health and telemetry

- `GET /api/v1/health/live`: process liveness, without opening the database.
- `GET /api/v1/health`: readiness using the configured database connection. It tests a basic SQL operation, not free disk space or an integrity scan.
- Both support HEAD, use `Cache-Control: no-store`, and bypass credentials, rate limits, and normal API admission. A live synchronous query can still delay the whole event loop, including health responses. Compose now uses readiness rather than downloading OpenAPI.
- Normal API responses include a generated `X-Request-Id` and `Server-Timing: app;dur=...`. `ELYTRA_LOG_REQUESTS=true` writes completion events containing request ID, HTTP method, route template, status, and duration. It excludes tokens, bodies, usernames, query strings, and message ciphertext. Successful health/OPTIONS fast paths omit these completion events.
- An optional Node `diagnostics_channel` subscriber on `elytra.api.request` receives the same event, enabling an existing monitoring integration without adding an SDK dependency. Treat subscribers as trusted process code; do not throw from them.

Track latency by route, 429/503 frequency, process CPU/RSS and event-loop delay, disk free space and fsync latency, DB/WAL sizes, and snapshot/rate-limit row counts. Request logs are optional because logging every read has its own cost. Do not cache personalized pages or REST responses at the CDN. Public `/api/media/*` responses are explicitly cacheable.

## Validate and measure

```sh
npm run test:backend
npm run test:api
npm run test:e2ee
npm run test:concurrency
npm run lint
npx tsc --noEmit
npm run build
```

Concurrency checks use a temporary file-backed WAL database and uploads. They cover admission/release, FIFO waiting/deadlines, password responsiveness, simultaneous registration, saturated health checks, slow and aborted bodies, upload limits, rate-window reset, counter rollback/cascades/backfill, bounded snapshots/statements, expiry, competing writers, and streamed/conditional media.

The HTTP load driver uses real HTTP requests with one independent fixture account per client. It reports status counts, throughput, and per-route p50/p95/p99 latency; non-2xx/network results fail the command. Samples use a bounded reservoir. This is a closed-loop test with no think time or retry/backoff, useful for finding saturation; it is not a prediction of daily active users or an open-loop overload test.

Use **new isolated files and a separate server port**, never the public installation. The fixture command refuses existing files, generates private session tokens, and defaults to 100 users, 10,000 posts, 30,000 likes, and up to ten follows per user:

```sh
load_dir=$(mktemp -d)
export ELYTRA_LOAD_FIXTURE_DB="$load_dir/load.db"
export ELYTRA_LOAD_TOKENS_FILE="$load_dir/tokens.json"
npm run seed:load

# In a separate terminal, use the printed DB path. Build once before starting.
mkdir -p .next/standalone/.next/static .next/standalone/public
cp -a .next/static/. .next/standalone/.next/static/
cp -a public/. .next/standalone/public/
PORT=3107 HOSTNAME=127.0.0.1 ELYTRA_DB_PATH=/absolute/path/to/load.db ELYTRA_SEED_DEMO=false node .next/standalone/server.js

# Against that isolated server:
export ELYTRA_LOAD_ORIGIN=http://127.0.0.1:3107
ELYTRA_LOAD_CONCURRENCY=25 ELYTRA_LOAD_SECONDS=30 npm run load:api
ELYTRA_LOAD_CONCURRENCY=100 ELYTRA_LOAD_SECONDS=30 npm run load:api
```

The commands above use the standalone build, matching Docker. Keep the running development server's build directory separate if testing simultaneously.

The default workload cycles through profile, Following, For You, notification count, and unread DM count. Set `ELYTRA_LOAD_WRITES=true ELYTRA_LOAD_POST_ID=load_post_0` to include idempotent like/unlike mutations **on the isolated fixture**. Larger fixtures use `ELYTRA_LOAD_USERS` (2–10,000) and `ELYTRA_LOAD_POSTS` (2–1,000,000) at creation time. Ensure the fixture has at least as many accounts as concurrent clients. Repeated long tests can legitimately encounter per-account rate limits; report those results rather than disabling protections for a flattering number.

Run a warm-up, then measure several concurrency levels on production builds. Include realistic uploads, polling, fresh-feed opens versus cursor reads, popular-post skew, and a larger graph/history dataset before choosing budgets. Measure the server separately from the load generator; running both on one machine shares CPU and understates/changes capacity. Results from a temporary filesystem do not establish durability throughput on the production disk.

The [recorded local measurements](benchmarks/README.md) include raw reports for 25- and 100-client runs, their hardware/filesystem context, and the limits of those measurements.

## Deploy, migrate, and recover

1. Back up the complete data directory using the [hosting guide](HOSTING.md). Stop the old app before deploying so schema/index creation and the one-time statistics backfill do not compete with requests. Large histories can make the first start slower; reserve disk space for indexes, WAL, and backfill.
2. Start exactly one app process against local persistent storage. Let readiness pass before routing traffic. Demo seeding stays disabled in production. Do not put a WAL database on NFS or a network-shared volume.
3. Watch latency, errors, disk/WAL growth, and memory while ramping traffic. Defaults are conservative starting points; raise budgets only when measurements show idle resources. More simultaneous SQLite work does not create more writer throughput.
4. Keep database, WAL state, and uploads consistent in backups. Test restoration on an isolated copy. Indexes, triggers, `post_stats`, and `backend_migrations` are part of that database. Old application versions that use ordinary SQL inserts/deletes remain covered by the triggers, but do not deploy schema-destructive old migrations over a newer database.

For an integrity check, stop the app and run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` against a backup/maintenance copy. If counters are suspected, compare `post_stats` to grouped source-table counts on that copy. A deliberate rebuild removes only the `post_stats_v1` marker from `backend_migrations` and runs `migrateBackend` again while the app is stopped; keep all source posts/interactions and triggers. Never delete the app's database to force a migration.

If p95 latency is dominated by graph/search queries or the single SQLite writer after indexing and workload tuning, the next architectural step is an asynchronous data-access boundary with a pooled server database, shared rate limits, and object storage for uploads. Background ranking/search indexes and denormalized inbox counts may also be needed. Multiple Next replicas require those shared services plus session, cursor, job, and media consistency; adding replicas around the current local files does not provide horizontal scaling.

References: [Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [Node SQLite](https://nodejs.org/api/sqlite.html), [SQLite WAL concurrency](https://sqlite.org/wal.html).

## Optional moderation

Public text writes can enqueue durable moderation jobs in the same SQLite
transaction. A bounded background worker scores them without delaying publishing;
encrypted DMs and images are excluded. See [MODERATION.md](MODERATION.md) for
shadow mode, guard capacity/circuit settings, the audit tables, and optional
reversible discovery exclusions. Moderation is disabled by default.

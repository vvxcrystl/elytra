<img src="assets/icon.svg" width="64" height="64" alt="">

# elytra

The light weight social media platform, built with [ts-rust](https://github.com/pingdotgg/ts-rust), Next.js 16, React 19, Tailwind CSS v4, and SQLite through Node's built-in `node:sqlite`. It needs no external services.

## Run it

You need Node 24 or newer for `node:sqlite`. The app was developed on Node 26.

```sh
npm install
npm run dev
```

Open http://localhost:3000. The first request creates and seeds the database at `data/elytra.db`. Sign in as `demo` with the password `password123`. The other seeded users (`theo`, `priya`, `marcus`, and more) use the same password.

## Host it on your own domain

The included Docker Compose setup serves Elytra at a URL such as `https://twitter.somedomain.org` through Cloudflare Tunnel.

```sh
cp .env.example .env
# Set your HTTPS URL and Cloudflare Tunnel token in .env.
docker compose up -d --build
```

Then point the tunnel's published hostname at `http://app:3000`. The database and uploads persist in a Docker volume, and the app starts with no demo accounts. The [hosting guide](docs/HOSTING.md) covers the Cloudflare steps, backups, and hosting without Docker.

## Backend capacity

The backend uses bounded asynchronous password work, request/upload admission limits, indexed SQLite queries with transaction-maintained engagement counters, capped feed snapshots, batched messaging reads, and streamed media. See the [backend operations guide](docs/BACKEND.md) for concurrency budgets, proxy setup, migrations, health checks, load testing, and the single-host scaling limits.

Optional [text moderation](docs/MODERATION.md) adds a local slur matcher, a tiny n-gram classifier and a Qwen3Guard sidecar with CPU, CUDA, ROCm, or Vulkan profiles. It is off by default; enabling it records scores in shadow mode unless the operator enables reversible review holds or discovery exclusions. With moderation enabled, high-severity names are rejected by default; ambiguous/reclaimed names remain allowed. Encrypted DMs and images are excluded.

Set `ELYTRA_MODERATION_PUBLISH=block` to check every post before publishing and show a composer error for unsafe content. Failed checks keep the draft unpublished for retry. See the moderation guide for setup.

## Features

Accounts and posting:

- Sign up with a username and password. The session token lives in an httpOnly cookie, and the database stores only its SHA-256 hash.
- Posts hold up to 280 characters and up to 4 images (PNG, JPEG, GIF, or WebP, 5 MB each). You can paste images into the composer.
- Posts support Markdown formatting, including bold, italic, links, lists, quotes, and code.
- You can reply, quote, repost, like, and bookmark. Replies appear on threaded detail pages.

Reading and finding people:

- The home timeline has a "For you" tab (everyone) and a "Following" tab. Both load more posts as you scroll.
- Profiles have Posts, Replies, Media, and Likes tabs, plus follower and following lists. The edit dialog covers name, bio, location, website, avatar, and banner.
- Search covers posts (Top, Latest, Media) and people. `#hashtags` and `@mentions` are links.
- The sidebar shows hashtags trending over the last 7 days and follow suggestions.
- Notifications cover likes, reposts, follows, replies, mentions, and quotes, with an unread badge.

Messaging and safety:

- Direct messages have an inbox, people search, paginated conversations, unread badges, read markers, and sender-side deletion. The browser encrypts every DM, and SQLite stores only signed ciphertext. A recovery code restores your keys on another device, and contacts can compare verification codes. See [the encryption docs](docs/E2EE.md).
- Blocking removes follows in both directions and stops interactions and messages. Muting hides an account from your feeds and notifications.

Other:

- The versioned REST API accepts cookie or bearer authentication. It provides idempotent interactions, image uploads, cursor pagination, input validation, and rate limits that persist across restarts. See the [API docs](docs/API.md) and `/api/v1/openapi.json`.
- Themes are light, dark, and system. The layout has three columns on desktop, an icon rail on tablets, and a bottom tab bar on phones.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the dev server |
| `npm run build` | Generates route types, checks with ts-rust, then builds for production |
| `npm run typecheck` | Generates route types and checks with ts-rust (`tsc-rs`) |
| `npm run typecheck:tsc` | Runs the original TypeScript checker for comparison |
| `npm run bench:typecheck` | Compares full and cached checks; add `-- --build` to also measure production builds |
| `npm start` | Runs the production server |
| `npm run seed` | Wipes `data/elytra.db` and reseeds the demo data |
| `npm run test:markdown` | Checks Markdown rendering, social links, and unsafe content |
| `npm run test:backend` | Runs the data-layer integration checks against an in-memory database |
| `npm run test:api` | Tests every REST operation and security boundary with isolated data and uploads |
| `npm run test:e2ee` | Checks encryption, tamper rejection, key recovery, and plaintext erasure |
| `npm run test:concurrency` | Tests overload recovery, body deadlines, concurrent writes, retention, and streaming with isolated files |
| `npm run test:moderation` | Tests slur matching/spans, name policy, scoring, guard failures, durable jobs, and reversible actions |
| `npm run bench:moderation` | Measures local slur, linear, and guard latency/throughput; reports an unavailable guard explicitly |
| `npm run train:moderation -- /path/to/civil-comments.jsonl` | Retrains compact int8 weights from public CC0 toxicity data |
| `npm run guard:up` | Starts the optional guard Compose profile selected by `ELYTRA_GUARD_BACKEND` |
| `npm run seed:load` | Creates a new isolated load-test database and private fixture tokens |
| `npm run load:api` | Measures mixed HTTP traffic against an explicitly configured test server |
| `npm run lint` | Runs ESLint |

Type checking uses [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust), pinned to `tsc-rs` 0.7.0. Keep npm's optional dependencies enabled to install its platform binary. TypeScript 5 remains installed for editor tooling and comparison. The build stops if the Rust check fails, then skips Next's duplicate check for that build process. Running `next build` directly still uses Next's original checker. See the [local compiler benchmark](docs/benchmarks/2026-10-14-ts-rust.md) for results and reproduction steps.

## Code layout

- `src/lib/types.ts` holds the types the server and UI share.
- `src/server/data/*.ts` holds the SQL. Each function takes the viewer ID as an argument. `src/server/queries.ts` (reads) and `src/server/actions.ts` (Server Actions) wrap those functions with the session from `auth.ts`.
- `src/server/api/` handles REST requests. Its endpoint registry also generates the OpenAPI 3.1 contract. The route `src/app/api/v1/[[...path]]` dispatches to it.
- `src/app/api/media/[file]` serves uploaded images from `data/uploads`.
- `src/app/(main)` holds the signed-in pages, and `src/app/(auth)` holds login and signup.
- `src/components/` holds the UI components.

## License

[MIT](LICENSE) © 2026 vvxcrystl.

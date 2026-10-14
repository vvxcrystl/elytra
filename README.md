<img src="assets/icon.svg" width="64" height="64" alt="">

# elytra

A Twitter-style social app built with Next.js 16, React 19, Tailwind CSS v4, and SQLite through Node's built-in `node:sqlite`. There are no external services and no native dependencies.

## Run it

Requires Node 24 or newer for `node:sqlite` (developed on Node 26).

```sh
npm install
npm run dev
```

Open http://localhost:3000. The database is created and seeded on first request at `data/elytra.db`. Sign in as `demo` / `password123`, or as any seeded user (`theo`, `priya`, `marcus`, and others) with the same password.

## Host on your own domain

Use the included Docker Compose setup to serve Elytra at a URL such as
`https://twitter.somedomain.org` through Cloudflare Tunnel:

```sh
cp .env.example .env
# Set your HTTPS URL and Cloudflare Tunnel token in .env.
docker compose up -d --build
```

Point the tunnel's published hostname at `http://app:3000`. The setup persists
your database and uploads and starts without demo accounts.
See [the hosting guide](docs/HOSTING.md) for the Cloudflare steps, backups,
and hosting without Docker.

## Features

- Accounts with username and password. Sessions live in an httpOnly cookie, and the database stores only a SHA-256 hash of each session token.
- Posts up to 280 characters with up to 4 images (PNG, JPEG, GIF, WebP, 5 MB each). Paste images straight into the composer.
- Replies with threaded detail pages, quote posts, reposts, likes, and bookmarks.
- Home timeline with "For you" (everyone) and "Following" tabs, loaded page by page as you scroll.
- Profiles with Posts, Replies, Media, and Likes tabs, follower and following lists, and an edit dialog for name, bio, location, website, avatar, and banner.
- Search across posts (Top, Latest, Media) and people. `#hashtags` and `@mentions` are links.
- Trending hashtags from the last 7 days and follow suggestions.
- Notifications for likes, reposts, follows, replies, mentions, and quotes, with an unread badge.
- Direct messages with an inbox, people search, paginated conversations, unread badges, read markers, and sender deletion. DMs are end-to-end encrypted in the browser; SQLite stores signed ciphertext only. Recovery codes restore keys on another device, and contacts can compare verification codes. See [encryption details](docs/E2EE.md).
- Blocking and muting, including messaging controls. Blocks remove follows in both directions and prevent interactions; mutes hide accounts from feeds and notifications.
- A versioned REST API with cookie or bearer authentication, idempotent interactions, image uploads, cursor pagination, validation, and persistent rate limits. See [API documentation](docs/API.md) and `/api/v1/openapi.json`.
- Light, dark, and system themes. The layout follows Twitter's three columns on desktop, an icon rail on tablets, and a bottom tab bar on phones.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build and server |
| `npm run seed` | Wipe `data/elytra.db` and re-seed the demo data |
| `npm run test:backend` | Run the data-layer integration checks against an in-memory database |
| `npm run test:api` | Test all REST operations and security boundaries with isolated data and uploads |
| `npm run test:e2ee` | Check encryption, tamper rejection, recovery, and legacy plaintext erasure |
| `npm run lint` | ESLint |

## Layout

- `src/lib/types.ts` holds the types shared by the server and the UI.
- `src/server/` is the backend. `data/*.ts` holds the SQL and takes a viewer ID explicitly. `queries.ts` (reads) and `actions.ts` (Server Actions) wrap it with the session from `auth.ts`.
- `src/app/api/media/[file]` serves uploaded images from `data/uploads`.
- `src/app/api/v1/[[...path]]` dispatches REST requests through `src/server/api/`. The endpoint registry also generates the OpenAPI 3.1 contract.
- `src/app/(main)` has the signed-in pages and `src/app/(auth)` has login and signup.
- `src/components/` holds the UI components.

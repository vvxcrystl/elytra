# Development

[Back to the README](README.md)

After installing dependencies, run the checks relevant to your changes:

```sh
npm run lint
npm run typecheck
npm run test:backend
npm run test:api
```

Use `npm run build` for a production build and `npm start` to serve it. The build checks types with `ts-rust` before compiling Next.js. Keep npm's optional dependencies enabled so it can install the compiler's platform binary. TypeScript remains installed for editors and comparison checks.

## Command reference

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


## Code layout

- `src/lib/types.ts` holds the types the server and UI share.
- `src/server/data/*.ts` holds the SQL. Each function takes the viewer ID as an argument. `src/server/queries.ts` (reads) and `src/server/actions.ts` (Server Actions) wrap those functions with the session from `auth.ts`.
- `src/server/api/` handles REST requests. Its endpoint registry also generates the OpenAPI 3.1 contract. The route `src/app/api/v1/[[...path]]` dispatches to it.
- `src/app/api/media/[file]` serves uploaded images from `data/uploads`.
- `src/app/(main)` holds the signed-in pages, and `src/app/(auth)` holds login and signup.
- `src/components/` holds the UI components.

# Elytra

Elytra is the lightweight social media platform


## Design Notes (taken from T3 Code's AGENTS.md)

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Keep business rules in `src/server/data/` or the relevant server module. Server Actions and API handlers should parse input, authenticate, call shared logic, and map errors. MCP tools reuse the API rather than duplicate its rules.
- Enforce permissions on the server when an operation runs. Hidden buttons are not access controls. Keep ownership, blocking, and moderation checks consistent across browser and agent requests.
- Keep SQL in the data layer and use transactions for related writes. Do not hold SQLite transactions open while awaiting network requests.
- Reuse components in `src/components/` and shared styles in `src/app/globals.css`. Add reusable appearance options to the component; keep page layout with its caller. Avoid copying components for small visual differences.
- Inferred types over annotations. `any` is the enemy.
- Comments should explain intent, constraints, or how to use a function. Update them when code moves or behavior changes. Skip narration of obvious statements.
- Keep feeds and interactions responsive. Bound queries and background work, avoid animations that repaint continuously, and make loading and error states match the actual operation.
- Treat these as defaults. If one conflicts with the task, explain the tradeoff and follow the developer's stated intent.

## Pull requests

Use conventional commit titles in plain language: `type(scope): description`. For example, `fix(composer): preserve drafts after failed posts` or `feat(api): add post search`. Choose a scope that names the affected area.

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

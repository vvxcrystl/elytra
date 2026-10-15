# Contributing to Elytra

## Before you start

Search existing issues before reporting a bug or starting work. For bugs, include reproduction steps, expected and actual behavior, and your browser, Node version, or hosting setup.

Discuss new features and major behavior changes with a maintainer before implementing them. Small, obvious fixes can go straight to a pull request. Submitting a PR does not guarantee review or a merge.

## Keep the change focused

Solve one problem per PR. Include the code, tests, and documentation it needs. Put unrelated cleanup in a separate PR.

Read [AGENTS.md](AGENTS.md) and [DEVELOPMENT.md](DEVELOPMENT.md) first. Elytra uses npm, Next.js, and SQLite. Check the installed Next.js documentation before changing framework code.

## Check your work

Run `npm run lint` and `npm run typecheck` for code changes. Choose tests for the behavior you changed:

- `npm run test:backend` for data access and database behavior.
- `npm run test:api` for HTTP endpoints, MCP tools, and access controls.
- `npm run test:e2ee` for encrypted messaging.
- `npm run test:concurrency` for admission limits and overload handling.
- `npm run test:moderation` for moderation policy and processing.
- `npm run test:markdown` for post formatting.

Use isolated test data. Keep tokens, passwords, database files, uploads, and model downloads out of commits.

## Open a pull request

Explain the problem, resulting behavior, and how you verified it. Link related issues and any agreed scope. List commands or manual checks and their results, including anything you could not check.

Attach before-and-after screenshots for UI changes. Add a short recording when interaction or timing matters. Update user documentation when usage changes.

If you use an AI agent, review its changes and verify them yourself before submitting.

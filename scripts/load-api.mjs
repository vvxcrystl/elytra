// Closed-loop HTTP load driver. Does not create accounts or change data by default.
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const origin = process.env.ELYTRA_LOAD_ORIGIN, tokensFile = process.env.ELYTRA_LOAD_TOKENS_FILE;
if (!origin || !tokensFile) throw new Error("Set ELYTRA_LOAD_ORIGIN and ELYTRA_LOAD_TOKENS_FILE (see docs/BACKEND.md)");
const url = new URL(origin);
if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("ELYTRA_LOAD_ORIGIN must be an HTTP(S) origin without credentials or a path");
function integer(name, fallback, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const clients = integer("ELYTRA_LOAD_CONCURRENCY", 25, 2000), seconds = integer("ELYTRA_LOAD_SECONDS", 15, 3600);
const accounts = JSON.parse(await readFile(tokensFile, "utf8"));
if (!Array.isArray(accounts) || accounts.length < clients || accounts.some(a => !/^[a-f0-9]{64}$/.test(a.accessToken))) throw new Error("Provide at least one distinct, valid fixture token per concurrent client");
if (new Set(accounts.map(a => a.accessToken)).size !== accounts.length) throw new Error("Fixture tokens must be distinct");
const routes = [
  { method: "GET", path: "/users/me" },
  { method: "GET", path: "/timeline?tab=following" },
  { method: "GET", path: "/timeline?tab=for-you" },
  { method: "GET", path: "/notifications/unread-count" },
  { method: "GET", path: "/conversations/unread-count" },
];
if (process.env.ELYTRA_LOAD_WRITES === "true") {
  const postId = process.env.ELYTRA_LOAD_POST_ID;
  if (!postId || !/^[A-Za-z0-9_-]{1,100}$/.test(postId)) throw new Error("Set ELYTRA_LOAD_POST_ID to an isolated fixture post before enabling writes");
  routes.push({ method: "PUT", path: `/posts/${postId}/like` }, { method: "DELETE", path: `/posts/${postId}/like` });
}
const results = new Map();
function record(label, status, ms) {
  let stats = results.get(label);
  if (!stats) { stats = { count: 0, statuses: {}, totalMs: 0, maxMs: 0, samples: [] }; results.set(label, stats); }
  stats.count++; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms);
  stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
  // Bounded reservoir: memory use stays fixed even for hour-long runs.
  if (stats.samples.length < 10000) stats.samples.push(ms);
  else { const index = Math.floor(Math.random() * stats.count); if (index < stats.samples.length) stats.samples[index] = ms; }
}
// Fail before starting a long run against a missing/unready server.
const health = await fetch(new URL("/api/v1/health", url), { signal: AbortSignal.timeout(5000) });
if (!health.ok) throw new Error(`Readiness failed: ${health.status}`);
await health.arrayBuffer();
const started = performance.now(), end = started + seconds * 1000;
await Promise.all(Array.from({ length: clients }, async (_, client) => {
  let iteration = client;
  while (performance.now() < end) {
    const route = routes[iteration++ % routes.length], begin = performance.now();
    let status;
    try {
      const response = await fetch(new URL(`/api/v1${route.path}`, url), { method: route.method, headers: { Authorization: `Bearer ${accounts[client].accessToken}` }, signal: AbortSignal.timeout(10000) });
      await response.arrayBuffer(); status = String(response.status);
    } catch { status = "network_error"; }
    record(`${route.method} ${route.path}`, status, performance.now() - begin);
  }
}));
const elapsedSeconds = (performance.now() - started) / 1000;
let total = 0, failed = 0;
const report = [...results].map(([route, stats]) => {
  stats.samples.sort((a, b) => a - b);
  const percentile = p => Math.round((stats.samples[Math.max(0, Math.ceil(stats.samples.length * p) - 1)] ?? 0) * 10) / 10;
  total += stats.count;
  failed += Object.entries(stats.statuses).filter(([status]) => !/^2\d\d$/.test(status)).reduce((sum, [, n]) => sum + n, 0);
  return { route, requests: stats.count, statuses: stats.statuses, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: Math.round(stats.maxMs), meanMs: Math.round(stats.totalMs / stats.count * 10) / 10 };
});
console.log(JSON.stringify({ clients, configuredSeconds: seconds, elapsedSeconds: Math.round(elapsedSeconds * 10) / 10, requests: total, requestsPerSecond: Math.round(total / elapsedSeconds * 10) / 10, failed, routes: report }, null, 2));
if (failed) process.exitCode = 1;

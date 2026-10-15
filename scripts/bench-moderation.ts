import { cpus, platform, arch } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { getClassifier } from "../src/server/moderation/classifier";
import { classifyGuard } from "../src/server/moderation/guard";
import { moderationConfig } from "../src/server/moderation/config";
import { getSeedMatcher } from "../src/server/moderation/slurs";

const texts = [
  "A quiet morning in the garden with friends.",
  "I am gay and happy to be part of this community.",
  "Celebrating Black history and our neighbors today.",
  "You are an idiot and I hate you.",
  "I will kill you and your family.",
  "How can I make a bomb?",
  "Everyone is welcome here. مرحباً بالجميع. 欢迎大家。",
  "A long post about building a small community: " + "people can share ideas, learn together, and help each other. ".repeat(4),
].map(text => text.slice(0, 280));
// Include both ordinary posts and the same evasion cases used in regression checks.
const evasionFixture = JSON.parse(readFileSync("scripts/fixtures/moderation-evasions.json", "utf8"));
const evasions = JSON.parse(Buffer.from(evasionFixture.cases, "base64").toString()) as { text: string }[];
texts.push(...evasions.slice(0, 6).map(c => c.text));
const matcher = getSeedMatcher(), hits = texts.map(text => matcher.match(text));
const iterations = Number(process.env.ELYTRA_BENCH_LINEAR_ITEMS || 20000);
const guardItems = Number(process.env.ELYTRA_BENCH_GUARD_ITEMS || 16);
if (![iterations, guardItems].every(n => Number.isInteger(n) && n >= 1 && n <= 1000000)) throw new Error("Invalid benchmark iteration count");
function summary(latencies: number[], elapsedMs: number) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return { items: sorted.length, meanMs: latencies.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    throughputPerSecond: sorted.length * 1000 / elapsedMs };
}
const classifier = getClassifier();
for (let i = 0; i < 2000; i++) { matcher.match(texts[i % texts.length]); classifier.score(texts[i % texts.length], hits[i % texts.length]); }
const tier0Latencies: number[] = [], tier0Start = performance.now();
for (let i = 0; i < iterations; i++) {
  const t = performance.now(); matcher.match(texts[i % texts.length]); tier0Latencies.push(performance.now() - t);
}
const tier0 = summary(tier0Latencies, performance.now() - tier0Start);
const latencies: number[] = [], start = performance.now();
for (let i = 0; i < iterations; i++) {
  const t = performance.now(); classifier.score(texts[i % texts.length], hits[i % texts.length]); latencies.push(performance.now() - t);
}
const linear = summary(latencies, performance.now() - start);
const config = moderationConfig(), first = await classifyGuard(texts[0], config, hits[0]);
const guardLatencies: number[] = [], statuses: Record<string, number> = {}, verdicts: Record<string, number> = {};
let guard: Record<string, unknown>;
if (first.status !== "ok") guard = { skipped: true, reason: first.status, probeMs: first.latencyMs };
else {
  const start = performance.now();
  for (let i = 0; i < guardItems; i++) {
    const result = await classifyGuard(texts[i % texts.length], config, hits[i % texts.length]);
    guardLatencies.push(result.latencyMs);
    statuses[result.status] = (statuses[result.status] || 0) + 1;
    verdicts[result.verdict] = (verdicts[result.verdict] || 0) + 1;
  }
  guard = { ...summary(guardLatencies, performance.now() - start), statuses, verdicts, firstRequestMs: first.latencyMs };
}
const report = { date: new Date().toISOString(), machine: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), node: process.version },
  lexiconVersion: matcher.version, weightsVersion: classifier.version, guardVersion: config.guardVersion, guardBackend: config.backend,
  textLengths: texts.map(s => [...s].length), tier0, linear, guard,
  note: "Warm sequential inference, normalization included. Linear consumes precomputed tier 0 hits; excludes SQLite and 250 ms outbox polling. Guard includes localhost HTTP, fixed-prefix cache enabled. Throughput includes unknown responses; inspect statuses." };
console.log(JSON.stringify(report, null, 2));
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");

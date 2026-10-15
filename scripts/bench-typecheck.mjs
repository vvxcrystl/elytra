// Sequential, interleaved compiler comparisons; never time failed checks as wins.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const builds = args.includes("--build");
const runsIndex = args.indexOf("--runs");
const runs = runsIndex < 0 ? 7 : Number(args[runsIndex + 1]);
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? null : args[outputIndex + 1];
const recognized = new Set(["--build", "--runs", "--output"]);
for (let i = 0; i < args.length; i++) {
  if (!recognized.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== "--build") i++;
}
if (!Number.isInteger(runs) || runs < 3 || runs > 100 || (outputIndex >= 0 && !output)) {
  throw new Error("Usage: npm run bench:typecheck -- [--runs 7] [--build] [--output report.json]");
}

const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ELYTRA_SEED_DEMO: "false", ELYTRA_DB_PATH: ":memory:" };
delete env.ELYTRA_RUST_TYPECHECKED;
for (const key of Object.keys(env)) if (key.startsWith("GOPORT_")) delete env[key];
const temp = mkdtempSync(join(tmpdir(), "elytra-typecheck-"));
const next = require.resolve("next/dist/bin/next");
const compilers = [
  { name: "tsc", package: "typescript", entry: require.resolve("typescript/bin/tsc") },
  { name: "tsc-rs", package: "tsc-rs", entry: join(dirname(require.resolve("tsc-rs/package.json")), "lib/tsc.js") },
];

function run(script, flags) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [script, ...flags], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
  });
  const elapsedMs = performance.now() - start;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} ${flags.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return { elapsedMs, stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

try {
  run(next, ["typegen"]);
  const common = ["--project", "tsconfig.json", "--noEmit", "--pretty", "false"];
  const fileLists = compilers.map(c => run(c.entry, [...common, "--incremental", "false", "--listFilesOnly"]).stdout.trim().split(/\r?\n/).map(f => resolve(f)).sort());
  // Each compiler ships its own standard library; compare project inputs separately.
  const projectLists = fileLists.map(files => files.filter(f => !f.includes("/node_modules/") && !f.includes("\\node_modules\\")));
  if (JSON.stringify(projectLists[0]) !== JSON.stringify(projectLists[1])) {
    throw new Error("Compilers selected different project files; investigate before comparing performance.");
  }
  const inputHash = createHash("sha256");
  for (const file of projectLists[0]) inputHash.update(file).update("\0").update(readFileSync(file)).update("\0");
  const scenarios = [
    { name: "full", description: "Full check, incremental disabled; filesystem cache remains warm", command: c => [c.entry, [...common, "--incremental", "false"]] },
    { name: "cached", description: "Unchanged incremental check; separate temporary cache per compiler", command: c => [c.entry, [...common, "--incremental", "true", "--tsBuildInfoFile", join(temp, `${c.name}.tsbuildinfo`)]] },
  ];
  if (builds) scenarios.push({
    name: "build", description: "Unchanged production build with warm .next caches; includes route generation, checking, bundling, and prerendering",
    command: c => c.name === "tsc" ? [next, ["build"]] : [resolve("scripts/build.mjs"), []],
  });
  const results = [];
  for (const scenario of scenarios) {
    console.error(`Benchmark: ${scenario.name} (1 warmup + ${runs} measured runs per compiler)`);
    const samples = Object.fromEntries(compilers.map(c => [c.name, []]));
    const warmups = {};
    const executionOrder = [];
    for (const c of compilers) {
      const [entry, flags] = scenario.command(c);
      warmups[c.name] = run(entry, flags);
    }
    for (let round = 0; round < runs; round++) {
      const order = round % 2 ? [...compilers].reverse() : compilers;
      for (const c of order) {
        const [entry, flags] = scenario.command(c);
        const sample = run(entry, flags);
        samples[c.name].push(sample);
        executionOrder.push(c.name);
        console.error(`  ${c.name}: ${(sample.elapsedMs / 1000).toFixed(3)}s`);
      }
    }
    const baseline = median(samples.tsc.map(s => s.elapsedMs));
    const rust = median(samples["tsc-rs"].map(s => s.elapsedMs));
    results.push({
      scenario: scenario.name, description: scenario.description, warmups, executionOrder,
      compilers: compilers.map(c => ({
        name: c.name, command: [process.execPath, ...scenario.command(c).flat()],
        samples: samples[c.name], medianMs: median(samples[c.name].map(s => s.elapsedMs)),
        minMs: Math.min(...samples[c.name].map(s => s.elapsedMs)), maxMs: Math.max(...samples[c.name].map(s => s.elapsedMs)),
      })),
      speedup: baseline / rust, reductionPercent: (1 - rust / baseline) * 100,
    });
  }
  const report = {
    measuredAt: new Date().toISOString(), revision: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    node: process.version, system: { platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, availableCpus: availableParallelism(), totalMemoryBytes: totalmem() },
    versions: Object.fromEntries([...compilers.map(c => c.package), "next"].map(p => [p, require(`${p}/package.json`).version])),
    runs, warmupsPerScenario: 1, projectFileCount: projectLists[0].length, inputSha256: inputHash.digest("hex"),
    inputFileCounts: Object.fromEntries(compilers.map((c, i) => [c.name, fileLists[i].length])),
    tsconfigSha256: createHash("sha256").update(readFileSync("tsconfig.json")).digest("hex"),
    method: "Elapsed wall time includes Node CLI startup. Sequential runs, alternating compiler order. All commands must exit 0. No OS filesystem-cache eviction. Default compiler thread counts. GOPORT_* cleared. Route types generated once outside compiler timings. Build timings include each build's own preparation. Build caches are warmed separately and retained.",
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, json);
  console.log(json);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

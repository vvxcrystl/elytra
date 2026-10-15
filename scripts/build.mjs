// Keep type errors fatal while replacing Next's built-in checker with tsc-rs.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next");
const rust = join(dirname(require.resolve("tsc-rs/package.json")), "lib/tsc.js");

function run(script, args, env = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(next, ["typegen"]);
run(rust, ["--noEmit", "--tsBuildInfoFile", ".next/cache/tsc-rs.tsbuildinfo"]);
run(next, ["build", ...process.argv.slice(2)], {
  ...process.env,
  ELYTRA_RUST_TYPECHECKED: "1",
});

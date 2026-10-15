import { spawnSync } from "node:child_process";

try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const backend = process.env.ELYTRA_GUARD_BACKEND || "cpu";
if (!["cpu", "cuda", "rocm", "vulkan"].includes(backend)) throw new Error("Invalid ELYTRA_GUARD_BACKEND");
const result = spawnSync("docker", ["compose", "-f", "compose.yaml", "-f", "compose.moderation.yaml",
  "--profile", `moderation-${backend}`, "up", "-d", `guard-${backend}`], { stdio: "inherit", env: {
    ...process.env,
    // Compose interpolates unrelated tunnel settings even when only starting a guard.
    ELYTRA_PUBLIC_ORIGIN: process.env.ELYTRA_PUBLIC_ORIGIN || "http://localhost:3000",
    CLOUDFLARE_TUNNEL_TOKEN: process.env.CLOUDFLARE_TUNNEL_TOKEN || "unused-local-guard",
  } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

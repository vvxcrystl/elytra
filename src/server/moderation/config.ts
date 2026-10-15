import "server-only";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function probability(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Invalid ${name}`);
  return n;
}
function choice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
  const value = process.env[name] ?? fallback;
  if (!choices.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}
export function moderationConfig() {
  const low = probability("ELYTRA_MODERATION_LOW", 0.2), high = probability("ELYTRA_MODERATION_HIGH", 0.8);
  if (low >= high) throw new Error("Moderation LOW must be less than HIGH");
  return {
    enabled: choice("ELYTRA_MODERATION", "false", ["false", "true"]) === "true",
    escalation: choice("ELYTRA_MODERATION_ESCALATION", "borderline", ["off", "borderline", "all"]),
    enforcement: choice("ELYTRA_MODERATION_ENFORCEMENT", "off", ["off", "discovery"]),
    publish: choice("ELYTRA_MODERATION_PUBLISH", "off", ["off", "block"]),
    slurAction: choice("ELYTRA_SLUR_ACTION", "shadow", ["shadow", "review", "reject-directed"]),
    slurNames: choice("ELYTRA_SLUR_NAMES", "reject", ["reject", "off"]),
    backend: choice("ELYTRA_GUARD_BACKEND", "cpu", ["cpu", "cuda", "rocm", "vulkan"]),
    weights: process.env.ELYTRA_MODERATION_WEIGHTS || "models/moderation/linear.json",
    guardUrl: process.env.ELYTRA_GUARD_URL || "http://127.0.0.1:8081",
    guardVersion: process.env.ELYTRA_GUARD_VERSION || "Qwen3Guard-Gen-0.6B:fada3b2:Q8_0",
    timeoutMs: integer("ELYTRA_GUARD_TIMEOUT_MS", 5000, 50, 60000),
    queue: integer("ELYTRA_GUARD_QUEUE", 16, 0, 256),
    failures: integer("ELYTRA_GUARD_FAILURES", 3, 1, 100),
    cooldownMs: integer("ELYTRA_GUARD_COOLDOWN_MS", 30000, 100, 600000),
    low, high, enforceMin: probability("ELYTRA_MODERATION_ENFORCE_MIN", 0.95),
  };
}
export type ModerationConfig = ReturnType<typeof moderationConfig>;

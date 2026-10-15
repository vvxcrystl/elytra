import "server-only";

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}
let config: ReturnType<typeof readConfig> | undefined;
function readConfig() {
  return {
    apiConcurrency: integer("ELYTRA_API_CONCURRENCY", 128, 1, 4096),
    mediaConcurrency: integer("ELYTRA_MEDIA_CONCURRENCY", 64, 1, 1024),
    uploadConcurrency: integer("ELYTRA_UPLOAD_CONCURRENCY", 8, 1, 128),
    passwordConcurrency: integer("ELYTRA_PASSWORD_CONCURRENCY", 2, 1, 32),
    passwordQueue: integer("ELYTRA_PASSWORD_QUEUE", 32, 0, 1024),
    passwordWaitMs: integer("ELYTRA_PASSWORD_WAIT_MS", 2000, 1, 30000),
    bodyTimeoutMs: integer("ELYTRA_BODY_TIMEOUT_MS", 15000, 10, 120000),
    busyTimeoutMs: integer("ELYTRA_DB_BUSY_TIMEOUT_MS", 250, 0, 5000),
    statementCacheSize: integer("ELYTRA_STATEMENT_CACHE_SIZE", 512, 0, 4096),
    snapshotsPerViewer: integer("ELYTRA_SNAPSHOTS_PER_VIEWER", 32, 1, 256),
    snapshotEntries: integer("ELYTRA_SNAPSHOT_ENTRIES", 1000, 100, 10000),
  };
}
export const backendConfig = () => config ??= readConfig();

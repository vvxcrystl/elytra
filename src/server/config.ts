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

function choice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
  const value = process.env[name] ?? fallback;
  if (!choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  return value as T;
}
function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required ${why}`);
  return value;
}
function httpUrl(name: string, value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a URL`); }
  // Plain http is only for a provider running on this machine during development.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${name} must use https`);
  return url;
}
/** How people sign in. "local" is username and password only. "oidc" adds an OpenID Connect
 * issuer such as CrystlCloud Accounts, and can turn password sign-in off. Read on each call,
 * because tests change the environment between cases. */
export function accountsConfig() {
  const mode = choice("ELYTRA_ACCOUNTS", "local", ["local", "oidc"]);
  const passwordLogin = choice("ELYTRA_PASSWORD_LOGIN", "true", ["true", "false"]) === "true";
  if (mode === "local") {
    if (!passwordLogin) throw new Error("ELYTRA_PASSWORD_LOGIN=false needs ELYTRA_ACCOUNTS=oidc, or nobody could sign in");
    return { passwordLogin, oidc: null };
  }
  const why = "when ELYTRA_ACCOUNTS=oidc";
  const issuer = required("ELYTRA_OIDC_ISSUER", why);
  httpUrl("ELYTRA_OIDC_ISSUER", issuer);
  const origin = httpUrl("ELYTRA_PUBLIC_ORIGIN", required("ELYTRA_PUBLIC_ORIGIN", why)).origin;
  return {
    passwordLogin,
    oidc: {
      // Kept exactly as written: it must equal the provider's `iss` claim character for character.
      issuer,
      clientId: required("ELYTRA_OIDC_CLIENT_ID", why),
      clientSecret: required("ELYTRA_OIDC_CLIENT_SECRET", why),
      name: process.env.ELYTRA_OIDC_NAME || "CrystlCloud",
      redirectUri: `${origin}/api/oidc/callback`,
    },
  };
}
export type OidcConfig = NonNullable<ReturnType<typeof accountsConfig>["oidc"]>;

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
  // Compose passes unset variables through as empty strings, so empty means "use the default".
  const value = process.env[name] || fallback;
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
export const CRYSTLCLOUD_ISSUER = "https://accounts.crystlcloud.org/api/auth";
/** How people sign in. "oidc", the default, signs in through CrystlCloud Accounts or another
 * OpenID Connect issuer, with password sign-in still on unless turned off. "local" is Elytra's own
 * usernames and passwords only. Read on each call, because tests change the environment between cases. */
export function accountsConfig() {
  const mode = choice("ELYTRA_ACCOUNTS", "oidc", ["local", "oidc"]);
  const passwordLogin = choice("ELYTRA_PASSWORD_LOGIN", "true", ["true", "false"]) === "true";
  if (mode === "local") {
    if (!passwordLogin) throw new Error("ELYTRA_PASSWORD_LOGIN=false needs ELYTRA_ACCOUNTS=oidc, or nobody could sign in");
    return { passwordLogin, oidc: null };
  }
  const issuer = process.env.ELYTRA_OIDC_ISSUER || CRYSTLCLOUD_ISSUER;
  httpUrl("ELYTRA_OIDC_ISSUER", issuer);
  const publicOrigin = process.env.ELYTRA_PUBLIC_ORIGIN;
  const callback = `${publicOrigin ? httpUrl("ELYTRA_PUBLIC_ORIGIN", publicOrigin).origin : "https://<your Elytra domain>"}/api/oidc/callback`;
  const clientId = process.env.ELYTRA_OIDC_CLIENT_ID, clientSecret = process.env.ELYTRA_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(`ELYTRA_OIDC_CLIENT_ID and ELYTRA_OIDC_CLIENT_SECRET are required: ELYTRA_ACCOUNTS is oidc (the default), so Elytra signs in through ${issuer}. ` +
      `Register Elytra with CrystlCloud Accounts by running \`npm run client -- add Elytra ${callback} --owner <your email>\` in the accounts server, ` +
      "then set both values from its output. To use only Elytra's own usernames and passwords instead, set ELYTRA_ACCOUNTS=local.");
  }
  // The redirect URI must match the registered one exactly, so it can't fall back to request headers.
  const redirectUri = `${httpUrl("ELYTRA_PUBLIC_ORIGIN", required("ELYTRA_PUBLIC_ORIGIN", "when signing in through an OIDC issuer")).origin}/api/oidc/callback`;
  return {
    passwordLogin,
    oidc: {
      // Kept exactly as written: it must equal the provider's `iss` claim character for character.
      issuer, clientId, clientSecret, redirectUri,
      name: process.env.ELYTRA_OIDC_NAME || "CrystlCloud",
    },
  };
}
export type OidcConfig = NonNullable<ReturnType<typeof accountsConfig>["oidc"]>;

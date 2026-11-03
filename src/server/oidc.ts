import "server-only";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountsConfig, type OidcConfig } from "./config";
import { saveOidcRequest, takeOidcRequest, userIdForIdentity, linkIdentity, savePendingSignup, syncedProfile, applyProfileSync, saveRefreshToken, profilePushState, recordPushedProfile, type Identity } from "./data/identities";
import { removeImages, saveImage, uploadDirectory, validateImage, validMediaName } from "./media";
import { AppError } from "./errors";

// OpenID Connect sign-in: authorization code flow with PKCE (S256), a client secret sent with
// HTTP Basic auth, and ID tokens checked with Node's crypto. Tested against CrystlCloud Accounts
// (Better Auth's OAuth provider, EdDSA keys); RS256 and ES256 keys from other issuers also work.

export const STATE_COOKIE = "elytra_oidc_state";
export const SIGNUP_COOKIE = "elytra_oidc_signup";
const TIMEOUT_MS = 10000;
const CLOCK_SKEW_S = 60;

type Metadata = {
  issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; jwks_uri: string;
  /** The issuer offers profile:write (CrystlCloud Accounts does), so Elytra can push profile edits back. */
  profileWrite: boolean;
};
const WRITE_SCOPE = "profile:write";
const base64url = (bytes: Buffer) => bytes.toString("base64url");
const random = () => base64url(randomBytes(32));

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body !== "object") throw new OidcError("provider", `${new URL(url).pathname} returned ${res.status}`);
  return body;
}

// Discovery and keys change rarely. Cache them per process and refetch the keys when an
// unknown key ID shows up, which is how issuers rotate keys.
let metadataCache: { issuer: string; at: number; value: Metadata } | undefined;
async function metadata(issuer: string): Promise<Metadata> {
  if (metadataCache?.issuer === issuer && Date.now() - metadataCache.at < 3600000) return metadataCache.value;
  const body = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const fields = ["issuer", "authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"] as const;
  if (fields.some(f => typeof body[f] !== "string")) throw new OidcError("provider", "discovery document is missing endpoints");
  if (body.issuer !== issuer) throw new OidcError("provider", `discovery issuer ${String(body.issuer)} does not match ELYTRA_OIDC_ISSUER`);
  const value = { ...Object.fromEntries(fields.map(f => [f, body[f] as string])), profileWrite: Array.isArray(body.scopes_supported) && body.scopes_supported.includes(WRITE_SCOPE) } as Metadata;
  metadataCache = { issuer, at: Date.now(), value };
  return value;
}
let keysCache: { uri: string; at: number; keys: JsonWebKey[] } | undefined;
async function signingKeys(uri: string, kid: string | undefined): Promise<JsonWebKey[]> {
  const known = keysCache?.uri === uri && keysCache.keys.some(k => k.kid === kid);
  if (keysCache?.uri === uri && (known || Date.now() - keysCache.at < 60000)) return keysCache.keys;
  const body = await fetchJson(uri);
  const keys = Array.isArray(body.keys) ? body.keys as JsonWebKey[] : [];
  keysCache = { uri, at: Date.now(), keys };
  return keys;
}

/** A sign-in failure. `code` picks the message shown on the login or settings page. */
export class OidcError extends Error {
  readonly code: keyof typeof OIDC_MESSAGES;
  constructor(code: keyof typeof OIDC_MESSAGES, detail: string) { super(detail); this.code = code; }
}
export const OIDC_MESSAGES = {
  denied: "Sign-in was cancelled.",
  state: "This sign-in link is invalid or expired. Try again.",
  token: "The sign-in response couldn't be verified. Try again.",
  provider: "The account service isn't responding. Try again later.",
  busy: "Too many sign-in attempts. Try again in a minute.",
  session: "Sign in to Elytra again, then connect your account.",
  identity_taken: "That account is already connected to another Elytra account.",
  already_linked: "Your Elytra account is already connected to a different account.",
};
export function oidcMessage(code: string | undefined): string | null {
  return code && Object.hasOwn(OIDC_MESSAGES, code) ? OIDC_MESSAGES[code as keyof typeof OIDC_MESSAGES] : null;
}

/** Starts a sign-in. Returns the provider URL to send the browser to and the state for its cookie. */
export async function beginOidc(config: OidcConfig, linkUserId: string | null): Promise<{ url: string; state: string }> {
  const provider = await metadata(config.issuer);
  const state = random(), nonce = random(), verifier = random();
  saveOidcRequest(state, verifier, nonce, linkUserId);
  const url = new URL(provider.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri,
    scope: `openid profile email offline_access${provider.profileWrite ? ` ${WRITE_SCOPE}` : ""}`, state, nonce,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  }).toString();
  return { url: url.href, state };
}

const ALGORITHMS: Record<string, { kty: string; crv?: string; hash: string | null }> = {
  EdDSA: { kty: "OKP", crv: "Ed25519", hash: null },
  RS256: { kty: "RSA", hash: "sha256" },
  ES256: { kty: "EC", crv: "P-256", hash: "sha256" },
};
/** Checks an ID token's signature, iss, aud, azp, exp and nonce, and returns its subject. */
export function verifyIdToken(token: string, keys: JsonWebKey[], expected: { issuer: string; clientId: string; nonce: string; now?: number }): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("token", "ID token is not a JWS");
  let header: { alg?: unknown; kid?: unknown }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch { throw new OidcError("token", "ID token is not valid JSON"); }
  const alg = typeof header.alg === "string" && Object.hasOwn(ALGORITHMS, header.alg) ? ALGORITHMS[header.alg] : null;
  if (!alg) throw new OidcError("token", `unsupported ID token algorithm ${String(header.alg)}`);
  const candidates = keys.filter(k => k.kty === alg.kty && (!alg.crv || k.crv === alg.crv) && (header.kid === undefined || k.kid === header.kid) && (!k.use || k.use === "sig"));
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2], "base64url");
  const valid = candidates.some(jwk => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verify(alg.hash, data, alg.kty === "EC" ? { key, dsaEncoding: "ieee-p1363" } : key, signature);
    } catch { return false; }
  });
  if (!valid) throw new OidcError("token", "ID token signature is invalid");
  const now = (expected.now ?? Date.now()) / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new OidcError("token", "ID token issuer does not match");
  if (!audience.includes(expected.clientId)) throw new OidcError("token", "ID token audience does not match");
  if (audience.length > 1 && claims.azp !== expected.clientId) throw new OidcError("token", "ID token azp does not match");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) throw new OidcError("token", "ID token expired");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce)) throw new OidcError("token", "ID token nonce does not match");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new OidcError("token", "ID token has no subject");
  return claims.sub;
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the callback route should do next. */
export type OidcOutcome =
  | { kind: "session"; userId: string }
  | { kind: "linked" }
  | { kind: "signup"; token: string }
  | { kind: "error"; code: OidcError["code"]; linking: boolean };

/** Finishes a sign-in from the provider's redirect. `cookieState` is the state this browser was
 * given when it started, and `viewerId` is whoever is signed in to Elytra right now. */
export async function completeOidc(config: OidcConfig, params: URLSearchParams, cookieState: string | undefined, viewerId: string | null): Promise<OidcOutcome> {
  const state = params.get("state") ?? "";
  // Only the browser that started the sign-in holds the state cookie, so a callback URL
  // copied into someone else's browser goes nowhere.
  if (!cookieState || !safeEqual(state, cookieState)) return { kind: "error", code: "state", linking: false };
  const request = takeOidcRequest(state);
  if (!request) return { kind: "error", code: "state", linking: false };
  const linking = request.linkUserId !== null;
  try {
    if (params.get("error")) throw new OidcError("denied", `provider returned ${params.get("error")}`);
    if (linking && viewerId !== request.linkUserId) throw new OidcError("session", "the Elytra user who started linking is not signed in");
    const code = params.get("code");
    if (!code) throw new OidcError("token", "callback has no code");
    const { identity, refreshToken } = await exchangeCode(config, code, request.verifier, request.nonce);
    const sealed = refreshToken && seal(config, refreshToken);
    if (viewerId && linking) {
      linkIdentity(viewerId, identity.issuer, identity.subject);
      saveRefreshToken(identity.issuer, identity.subject, sealed);
      await syncProfile(config, identity);
      return { kind: "linked" };
    }
    const userId = userIdForIdentity(identity.issuer, identity.subject);
    if (!userId) return { kind: "signup", token: savePendingSignup(identity, sealed) };
    saveRefreshToken(identity.issuer, identity.subject, sealed);
    await syncProfile(config, identity);
    return { kind: "session", userId };
  } catch (error) {
    if (error instanceof AppError && (error.code === "identity_taken" || error.code === "already_linked")) return { kind: "error", code: error.code, linking };
    if (!(error instanceof OidcError)) throw error;
    console.warn(`OIDC sign-in failed: ${error.message}`);
    return { kind: "error", code: error.code, linking };
  }
}

async function exchangeCode(config: OidcConfig, code: string, verifier: string, nonce: string): Promise<{ identity: Identity; refreshToken: string | null }> {
  const provider = await metadata(config.issuer);
  // client_secret_basic form-encodes the ID and secret before joining them (RFC 6749 section 2.3.1).
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
  const tokens = await fetchJson(provider.token_endpoint, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier }),
  }).catch(error => { throw error instanceof OidcError ? new OidcError("token", error.message) : error; });
  if (typeof tokens.id_token !== "string" || typeof tokens.access_token !== "string") throw new OidcError("token", "token response is missing tokens");
  let kid: string | undefined;
  try { kid = JSON.parse(Buffer.from(tokens.id_token.split(".")[0], "base64url").toString()).kid; } catch { /* verifyIdToken rejects it */ }
  const subject = verifyIdToken(tokens.id_token, await signingKeys(provider.jwks_uri, kid), { issuer: config.issuer, clientId: config.clientId, nonce });
  // The ID token carries no profile, so the name and picture come from userinfo.
  const info = await fetchJson(provider.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (info.sub !== subject) throw new OidcError("token", "userinfo subject does not match the ID token");
  const picture = typeof info.picture === "string" && /^https?:\/\//.test(info.picture) ? info.picture : null;
  // Keep the refresh token only when it can write the profile; that's all Elytra uses it for.
  const granted = typeof tokens.scope === "string" ? tokens.scope.split(" ").includes(WRITE_SCOPE) : provider.profileWrite;
  return {
    identity: { issuer: config.issuer, subject, name: typeof info.name === "string" ? info.name.trim().slice(0, 200) : "", picture },
    refreshToken: granted && typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
  };
}

/** Downloads the issuer's profile photo for a new account. Only fetches from the issuer's own
 * origin, so a userinfo response can't make Elytra request arbitrary URLs. */
export async function fetchPicture(config: OidcConfig, picture: string): Promise<File | null> {
  try {
    if (new URL(picture).origin !== new URL(config.issuer).origin) return null;
    const res = await fetch(picture, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get("content-type")?.split(";")[0] ?? "";
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 5 * 1024 * 1024) return null;
    return new File([await res.arrayBuffer()], "avatar", { type });
  } catch (error) { console.warn("Unable to fetch the profile photo", error); return null; }
}

/** Keeps the Elytra display name and avatar in step with the issuer's profile. Runs on each sign-in
 * and when an account is connected. Only values that changed on the issuer since the last copy are
 * applied, so edits made in Elytra stay until the issuer's value changes again. Never fails sign-in. */
async function syncProfile(config: OidcConfig, identity: Identity): Promise<void> {
  let saved: string | null = null;
  try {
    const synced = syncedProfile(identity.issuer, identity.subject);
    if (!synced) return;
    const update: Parameters<typeof applyProfileSync>[2] = {};
    if (identity.name && identity.name !== synced.name) update.name = identity.name;
    if (identity.picture !== synced.picture) {
      if (identity.picture) {
        const file = await fetchPicture(config, identity.picture);
        saved = file && await validateImage(file).then(saveImage).catch(() => null);
        // A photo that couldn't be downloaded is tried again at the next sign-in.
        if (saved) update.picture = { url: identity.picture, avatarUrl: saved };
      } else update.picture = { url: null, avatarUrl: null };
    }
    if (!update.name && !update.picture) return;
    await removeImages(applyProfileSync(identity.issuer, identity.subject, update));
  } catch (error) {
    if (saved) await removeImages([saved]);
    console.error("Unable to sync the profile from the account service", error);
  }
}

// Refresh tokens are sealed with a key derived from the client secret, which lives in the
// environment, so a copy of the database alone can't write anyone's profile.
const sealKey = (config: OidcConfig) => createHash("sha256").update(`elytra profile sync\0${config.clientSecret}`).digest();
function seal(config: OidcConfig, value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sealKey(config), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return base64url(Buffer.concat([iv, cipher.getAuthTag(), data]));
}
function unseal(config: OidcConfig, sealed: string): string | null {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKey(config), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return null; }
}

// The issuer's profile endpoint accepts JPEG, PNG and WebP up to 1 MB.
const PUSH_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const PUSH_MAX_BYTES = 1024 * 1024;
const pushes = new Map<string, Promise<void>>();

/** Sends Elytra-side changes to the linked user's name or avatar back to the issuer, so the profile
 * stays the same in both places. Compares the current values with the last synced ones, so it's safe
 * to call after any profile edit. One push runs per user at a time, because each refresh rotates the
 * refresh token. Never throws. */
/** Call after a profile edit. Pushes in the background when an issuer is configured, so the edit
 * doesn't wait on the issuer. Elytra runs as one long-lived Node process, so the push finishes. */
export function pushProfileLater(userId: string): void {
  const config = accountsConfig().oidc;
  if (config) void pushProfile(config, userId);
}
export function pushProfile(config: OidcConfig, userId: string): Promise<void> {
  const next = (pushes.get(userId) ?? Promise.resolve()).then(() => pushProfileNow(config, userId));
  pushes.set(userId, next);
  return next.finally(() => { if (pushes.get(userId) === next) pushes.delete(userId); });
}
async function pushProfileNow(config: OidcConfig, userId: string): Promise<void> {
  try {
    const state = profilePushState(userId, config.issuer);
    const refreshToken = state?.refresh_token && unseal(config, state.refresh_token);
    if (!state || !refreshToken) return;
    const syncedName = state.synced_name === null ? null : [...state.synced_name.trim()].slice(0, 50).join("");
    const body: { name?: string; photo?: string | null } = {};
    if (state.display_name !== syncedName) body.name = state.display_name;
    if (state.avatar_url !== state.synced_avatar_url) {
      const photo = state.avatar_url && await photoDataUrl(state.avatar_url);
      // GIFs and very large avatars stay in Elytra only; the name still syncs.
      if (photo !== undefined) body.photo = photo;
    }
    if (body.name === undefined && body.photo === undefined) return;

    const provider = await metadata(config.issuer);
    const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
    const refreshed = await fetch(provider.token_endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const tokens = await refreshed.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown };
    if (!refreshed.ok || typeof tokens.access_token !== "string") {
      // A revoked or expired grant can't recover; the next sign-in stores a new one.
      if (refreshed.status === 400 || refreshed.status === 401) saveRefreshToken(config.issuer, state.subject, null);
      throw new Error(`refresh returned ${refreshed.status}`);
    }
    if (typeof tokens.refresh_token === "string") saveRefreshToken(config.issuer, state.subject, seal(config, tokens.refresh_token));

    const res = await fetch(`${new URL(config.issuer).origin}/api/profile`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token, ...body }),
    });
    const saved = await res.json().catch(() => ({})) as { name?: unknown; picture?: unknown };
    if (!res.ok) throw new Error(`profile update returned ${res.status}`);
    recordPushedProfile(config.issuer, state.subject, {
      name: body.name !== undefined && typeof saved.name === "string" ? saved.name : undefined,
      picture: body.photo !== undefined ? { url: typeof saved.picture === "string" ? saved.picture : null, avatarUrl: state.avatar_url } : undefined,
    });
  } catch (error) {
    console.error("Unable to send the profile change to the account service", error);
  }
}
/** The stored avatar as a data URL, or undefined when the issuer wouldn't accept it. */
async function photoDataUrl(avatarUrl: string): Promise<string | undefined> {
  const name = avatarUrl.replace(/^\/api\/media\//, "");
  const type = PUSH_TYPES[name.split(".").pop() ?? ""];
  if (!avatarUrl.startsWith("/api/media/") || !validMediaName(name) || !type) return undefined;
  const bytes = await readFile(join(/*turbopackIgnore: true*/ uploadDirectory(), name)).catch(() => null);
  if (!bytes || bytes.length > PUSH_MAX_BYTES) return undefined;
  return `data:${type};base64,${bytes.toString("base64")}`;
}

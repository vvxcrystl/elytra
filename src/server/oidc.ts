import "server-only";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import type { OidcConfig } from "./config";
import { saveOidcRequest, takeOidcRequest, userIdForIdentity, linkIdentity, savePendingSignup, type Identity } from "./data/identities";
import { AppError } from "./errors";

// OpenID Connect sign-in: authorization code flow with PKCE (S256), a client secret sent with
// HTTP Basic auth, and ID tokens checked with Node's crypto. Tested against CrystlCloud Accounts
// (Better Auth's OAuth provider, EdDSA keys); RS256 and ES256 keys from other issuers also work.

export const STATE_COOKIE = "elytra_oidc_state";
export const SIGNUP_COOKIE = "elytra_oidc_signup";
const TIMEOUT_MS = 10000;
const CLOCK_SKEW_S = 60;

type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; jwks_uri: string };
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
  const value = Object.fromEntries(fields.map(f => [f, body[f] as string])) as Metadata;
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
    scope: "openid profile email offline_access", state, nonce,
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
    const identity = await exchangeCode(config, code, request.verifier, request.nonce);
    if (viewerId && linking) {
      linkIdentity(viewerId, identity.issuer, identity.subject);
      return { kind: "linked" };
    }
    const userId = userIdForIdentity(identity.issuer, identity.subject);
    return userId ? { kind: "session", userId } : { kind: "signup", token: savePendingSignup(identity) };
  } catch (error) {
    if (error instanceof AppError && (error.code === "identity_taken" || error.code === "already_linked")) return { kind: "error", code: error.code, linking };
    if (!(error instanceof OidcError)) throw error;
    console.warn(`OIDC sign-in failed: ${error.message}`);
    return { kind: "error", code: error.code, linking };
  }
}

async function exchangeCode(config: OidcConfig, code: string, verifier: string, nonce: string): Promise<Identity> {
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
  return { issuer: config.issuer, subject, name: typeof info.name === "string" ? info.name.trim().slice(0, 200) : "", picture };
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

import "server-only";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb } from "../src/server/db";
import { authenticate, createUser, one, run } from "../src/server/data/core";
import { createUserFromSignup, linkIdentity, pendingSignup, userIdForIdentity } from "../src/server/data/identities";
import { accountsConfig, CRYSTLCLOUD_ISSUER } from "../src/server/config";
import { beginOidc, completeOidc } from "../src/server/oidc";

// A fake issuer on a random local port stands in for CrystlCloud Accounts: discovery, JWKS,
// a token endpoint that checks the client secret and PKCE verifier, and userinfo.
process.env.ELYTRA_DB_PATH = ":memory:";
process.env.ELYTRA_SEED_DEMO = "false";
const signer = generateKeyPairSync("ed25519"), stranger = generateKeyPairSync("ed25519");
type Grant = { challenge: string; nonce: string; sub: string; claims?: Record<string, unknown>; key?: KeyObject };
const grants = new Map<string, Grant>();
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, issuerOrigin), json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/auth/.well-known/openid-configuration") return json(200, { issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, userinfo_endpoint: `${issuer}/oauth2/userinfo`, jwks_uri: `${issuer}/jwks` });
  if (url.pathname === "/api/auth/jwks") return json(200, { keys: [{ ...signer.publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA" }] });
  if (url.pathname === "/api/auth/oauth2/token") {
    let body = ""; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body), grant = grants.get(form.get("code") ?? "");
    const verifier = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (req.headers.authorization !== `Basic ${Buffer.from("elytra-test:s3cret").toString("base64")}` || !grant || verifier !== grant.challenge || form.get("redirect_uri") !== "http://localhost:4000/api/oidc/callback") return json(400, { error: "invalid_grant" });
    grants.delete(form.get("code")!);
    const claims = { iss: issuer, aud: "elytra-test", sub: grant.sub, nonce: grant.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...grant.claims };
    const signed = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "k1" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return json(200, { access_token: `at-${grant.sub}`, token_type: "Bearer", id_token: `${signed}.${sign(null, Buffer.from(signed), grant.key ?? signer.privateKey).toString("base64url")}` });
  }
  if (url.pathname === "/api/auth/oauth2/userinfo") {
    const sub = req.headers.authorization?.replace(/^Bearer at-/, "");
    return json(200, { sub, name: "Robin Example", email: "robin@private.example", email_verified: true, picture: `${issuerOrigin}/photos/${sub}` });
  }
  json(404, {});
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const issuerOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, issuer = `${issuerOrigin}/api/auth`;
Object.assign(process.env, { ELYTRA_ACCOUNTS: "oidc", ELYTRA_OIDC_ISSUER: issuer, ELYTRA_OIDC_CLIENT_ID: "elytra-test", ELYTRA_OIDC_CLIENT_SECRET: "s3cret", ELYTRA_PUBLIC_ORIGIN: "http://localhost:4000" });
getDb();
const config = accountsConfig().oidc!;

/** Runs the browser's side of the flow: start, "sign in" at the issuer as `sub`, and return to the callback. */
async function signIn(sub: string, options: { linkUserId?: string | null; viewerId?: string | null; claims?: Record<string, unknown>; key?: KeyObject; cookieState?: string } = {}) {
  const { url, state } = await beginOidc(config, options.linkUserId ?? null);
  const params = new URL(url).searchParams, code = `code-${Math.random()}`;
  assert.equal(params.get("code_challenge_method"), "S256");
  grants.set(code, { challenge: params.get("code_challenge")!, nonce: params.get("nonce")!, sub, claims: options.claims, key: options.key });
  return completeOidc(config, new URLSearchParams({ code, state }), options.cookieState ?? state, options.viewerId ?? null);
}
let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${label}`); }
try {
  const alice = await createUser("oidc_alice", "Alice", "securepass123"), bob = await createUser("oidc_bob", "Bob", "securepass123");

  await check("identity links: one per issuer subject and per user, removed with the user", async () => {
    linkIdentity(alice.id, issuer, "sub-alice");
    linkIdentity(alice.id, issuer, "sub-alice");
    assert.equal(userIdForIdentity(issuer, "sub-alice"), alice.id);
    assert.equal(userIdForIdentity("https://other.example", "sub-alice"), null);
    assert.throws(() => linkIdentity(bob.id, issuer, "sub-alice"), { code: "identity_taken" });
    assert.throws(() => linkIdentity(alice.id, issuer, "sub-other"), { code: "already_linked" });
    const temp = await createUser("oidc_temp", "Temp", "securepass123");
    linkIdentity(temp.id, issuer, "sub-temp");
    run("DELETE FROM users WHERE id=?", temp.id);
    assert.equal(userIdForIdentity(issuer, "sub-temp"), null);
  });

  await check("callback rejects a bad state, a replayed state, a bad nonce, a wrong audience, and a bad signature", async () => {
    assert.deepEqual(await signIn("sub-alice", { cookieState: "someone-elses-state" }), { kind: "error", code: "state", linking: false });
    const { state } = await beginOidc(config, null);
    assert.deepEqual(await completeOidc(config, new URLSearchParams({ code: "x", state }), undefined, null), { kind: "error", code: "state", linking: false });
    assert.deepEqual(await completeOidc(config, new URLSearchParams({ code: "x", state }), state, null), { kind: "error", code: "token", linking: false });
    assert.deepEqual(await completeOidc(config, new URLSearchParams({ code: "x", state }), state, null), { kind: "error", code: "state", linking: false }, "a state works once");
    for (const [label, options] of [
      ["nonce", { claims: { nonce: "forged" } }],
      ["audience", { claims: { aud: "another-client" } }],
      ["issuer", { claims: { iss: "https://evil.example" } }],
      ["expiry", { claims: { exp: Math.floor(Date.now() / 1000) - 600 } }],
      ["signature", { key: stranger.privateKey }],
    ] as const) assert.deepEqual(await signIn("sub-alice", options), { kind: "error", code: "token", linking: false }, label);
    assert.deepEqual(await signIn("sub-alice", { claims: { aud: ["elytra-test", "other"], azp: "other" } }), { kind: "error", code: "token", linking: false }, "azp");
    assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM sessions")!.n, 0);
  });

  await check("a linked identity signs in to the existing user", async () => {
    assert.deepEqual(await signIn("sub-alice"), { kind: "session", userId: alice.id });
    assert.deepEqual(await signIn("sub-alice", { claims: { aud: ["elytra-test"] } }), { kind: "session", userId: alice.id });
  });

  await check("linking needs the same signed-in user who started it, and never matches by email", async () => {
    assert.deepEqual(await signIn("sub-bob", { linkUserId: bob.id, viewerId: alice.id }), { kind: "error", code: "session", linking: true });
    assert.deepEqual(await signIn("sub-bob", { linkUserId: bob.id, viewerId: null }), { kind: "error", code: "session", linking: true });
    assert.equal(userIdForIdentity(issuer, "sub-bob"), null);
    assert.deepEqual(await signIn("sub-alice", { linkUserId: bob.id, viewerId: bob.id }), { kind: "error", code: "identity_taken", linking: true });
    assert.deepEqual(await signIn("sub-bob", { linkUserId: bob.id, viewerId: bob.id }), { kind: "linked" });
    assert.deepEqual(await signIn("sub-bob"), { kind: "session", userId: bob.id });
  });

  await check("first sign-in waits for a username, then creates a password-less linked account", async () => {
    const users = one<{ n: number }>("SELECT COUNT(*) n FROM users")!.n;
    const outcome = await signIn("sub-new");
    assert.equal(outcome.kind, "signup");
    const token = outcome.kind === "signup" ? outcome.token : "";
    assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM users")!.n, users, "no account before a username is chosen");
    assert.deepEqual({ ...pendingSignup(token) }, { issuer, subject: "sub-new", name: "Robin Example", picture: `${issuerOrigin}/photos/sub-new` });
    assert(!JSON.stringify(one("SELECT * FROM oidc_signups")).includes("robin@private.example"), "the email is never stored");
    const input = { displayName: "Robin Example", aiOperated: false, avatarUrl: null };
    assert.throws(() => createUserFromSignup(token, { ...input, username: "OIDC_ALICE" }), { code: "username_taken" });
    assert.throws(() => createUserFromSignup(token, { ...input, username: "settings" }), /isn't available/);
    const robin = createUserFromSignup(token, { ...input, username: "robin" });
    assert.equal(robin.displayName, "Robin Example");
    assert.equal(userIdForIdentity(issuer, "sub-new"), robin.id);
    assert.equal(await authenticate("robin", ""), null);
    assert.throws(() => createUserFromSignup(token, { ...input, username: "robin2" }), { code: "signup_expired" });
    assert.deepEqual(await signIn("sub-new"), { kind: "session", userId: robin.id });
  });

  await check("config: CrystlCloud by default, local accounts on request, and missing client credentials fail with the fix", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ELYTRA_ACCOUNTS; delete process.env.ELYTRA_OIDC_ISSUER; delete process.env.ELYTRA_OIDC_NAME;
      assert.deepEqual(accountsConfig().oidc, { issuer: CRYSTLCLOUD_ISSUER, clientId: "elytra-test", clientSecret: "s3cret", redirectUri: "http://localhost:4000/api/oidc/callback", name: "CrystlCloud" });
      assert.equal(accountsConfig().passwordLogin, true);
      process.env.ELYTRA_ACCOUNTS = "";
      assert.equal(accountsConfig().oidc?.issuer, CRYSTLCLOUD_ISSUER, "an empty value from Compose means the default");
      delete process.env.ELYTRA_OIDC_CLIENT_SECRET;
      assert.throws(accountsConfig, (error: Error) => /ELYTRA_OIDC_CLIENT_ID and ELYTRA_OIDC_CLIENT_SECRET are required/.test(error.message)
        && error.message.includes("npm run client -- add Elytra http://localhost:4000/api/oidc/callback") && error.message.includes("ELYTRA_ACCOUNTS=local"));
      process.env.ELYTRA_ACCOUNTS = "local";
      assert.deepEqual(accountsConfig(), { passwordLogin: true, oidc: null });
      process.env.ELYTRA_PASSWORD_LOGIN = "false";
      assert.throws(accountsConfig, /needs ELYTRA_ACCOUNTS=oidc/);
      process.env.ELYTRA_ACCOUNTS = "oidc"; process.env.ELYTRA_OIDC_CLIENT_SECRET = "s3cret";
      assert.equal(accountsConfig().passwordLogin, false);
      process.env.ELYTRA_OIDC_ISSUER = "http://accounts.example/api/auth";
      assert.throws(accountsConfig, /must use https/);
    } finally { process.env = saved; }
  });
  console.log(`OIDC checks passed: ${checks} groups against a local fake issuer.`);
} finally { server.close(); }

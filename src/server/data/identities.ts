import "server-only";
import { randomBytes } from "node:crypto";
import type { Viewer } from "@/lib/types";
import { transaction } from "../db";
import { tokenHash } from "../security";
import { AppError } from "../errors";
import { insertUser, one, run, userByUsername } from "./core";

/** An identity the issuer vouched for: the ID token's iss and sub, plus profile fields from userinfo. */
export type Identity = { issuer: string; subject: string; name: string; picture: string | null };

const REQUEST_AGE = 10 * 60 * 1000;
const SIGNUP_AGE = 30 * 60 * 1000;

export function userIdForIdentity(issuer: string, subject: string): string | null {
  return one<{ user_id: string }>("SELECT user_id FROM identity_links WHERE issuer=? AND subject=?", issuer, subject)?.user_id ?? null;
}
export function isLinked(userId: string, issuer: string): boolean {
  return !!one("SELECT 1 FROM identity_links WHERE user_id=? AND issuer=?", userId, issuer);
}
/** Connects an issuer account to an existing user. Each side can have only one link per issuer.
 * Never call this because two accounts share an email address. */
export function linkIdentity(userId: string, issuer: string, subject: string): void {
  transaction(() => {
    const owner = userIdForIdentity(issuer, subject);
    if (owner === userId) return;
    if (owner) throw new AppError(409, "identity_taken", "That account is already connected to another Elytra account");
    if (isLinked(userId, issuer)) throw new AppError(409, "already_linked", "Your Elytra account is already connected to a different account");
    run("INSERT INTO identity_links(issuer,subject,user_id,created_at) VALUES(?,?,?,?)", issuer, subject, userId, Date.now());
  });
}

/** Remembers a started sign-in. `linkUserId` is set when a signed-in user is connecting an account. */
export function saveOidcRequest(state: string, verifier: string, nonce: string, linkUserId: string | null): void {
  run("INSERT INTO oidc_requests(state_hash,verifier,nonce,link_user_id,expires_at) VALUES(?,?,?,?,?)", tokenHash(state), verifier, nonce, linkUserId, Date.now() + REQUEST_AGE);
}
/** Returns and deletes the request for this state, so each one completes at most once. */
export function takeOidcRequest(state: string): { verifier: string; nonce: string; linkUserId: string | null } | null {
  const row = one<{ verifier: string; nonce: string; link_user_id: string | null; expires_at: number }>(
    "DELETE FROM oidc_requests WHERE state_hash=? RETURNING verifier,nonce,link_user_id,expires_at", tokenHash(state));
  if (!row || row.expires_at <= Date.now()) return null;
  return { verifier: row.verifier, nonce: row.nonce, linkUserId: row.link_user_id };
}

/** Holds a verified identity that has no account yet. The returned token goes in a cookie. */
export function savePendingSignup(identity: Identity): string {
  const token = randomBytes(32).toString("hex");
  run("INSERT INTO oidc_signups(token_hash,issuer,subject,name,picture,expires_at) VALUES(?,?,?,?,?,?)",
    tokenHash(token), identity.issuer, identity.subject, identity.name, identity.picture, Date.now() + SIGNUP_AGE);
  return token;
}
export function pendingSignup(token: string): Identity | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return one<Identity>("SELECT issuer,subject,name,picture FROM oidc_signups WHERE token_hash=? AND expires_at>?", tokenHash(token), Date.now()) ?? null;
}
/** Creates the account for a pending signup and links it, in one transaction. The account has no
 * password. The username comes from the person, never from the issuer's email or name. */
export function createUserFromSignup(token: string, input: { username: string; displayName: string; aiOperated: boolean; avatarUrl: string | null }): Viewer {
  return transaction(() => {
    const identity = pendingSignup(token);
    if (!identity) throw new AppError(410, "signup_expired", "This sign-in expired. Start again.");
    if (userIdForIdentity(identity.issuer, identity.subject)) throw new AppError(409, "identity_taken", "That account already has an Elytra account. Sign in instead.");
    if (userByUsername(input.username)) throw new AppError(409, "username_taken", "That username is already taken");
    const viewer = insertUser(input.username, input.displayName, "", input.aiOperated, input.avatarUrl);
    run("INSERT INTO identity_links(issuer,subject,user_id,created_at) VALUES(?,?,?,?)", identity.issuer, identity.subject, viewer.id, Date.now());
    run("DELETE FROM oidc_signups WHERE token_hash=?", tokenHash(token));
    return viewer;
  });
}

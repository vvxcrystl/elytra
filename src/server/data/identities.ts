import "server-only";
import { randomBytes } from "node:crypto";
import type { Viewer } from "@/lib/types";
import { transaction } from "../db";
import { tokenHash } from "../security";
import { AppError } from "../errors";
import { insertUser, one, run, userByUsername, type UserRow } from "./core";
import { assertNameAllowed } from "../moderation/policy";

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
export function savePendingSignup(identity: Identity, sealedRefreshToken: string | null = null): string {
  const token = randomBytes(32).toString("hex");
  run("INSERT INTO oidc_signups(token_hash,issuer,subject,name,picture,expires_at,refresh_token) VALUES(?,?,?,?,?,?,?)",
    tokenHash(token), identity.issuer, identity.subject, identity.name, identity.picture, Date.now() + SIGNUP_AGE, sealedRefreshToken);
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
    // Record the issuer's name and picture as already synced, so the choices made here stay until
    // they change on the issuer's side.
    run(`INSERT INTO identity_links(issuer,subject,user_id,created_at,synced_name,synced_picture,synced_avatar_url,refresh_token)
      SELECT ?,?,?,?,?,?,?,refresh_token FROM oidc_signups WHERE token_hash=?`,
      identity.issuer, identity.subject, viewer.id, Date.now(), identity.name, identity.picture, input.avatarUrl, tokenHash(token));
    run("DELETE FROM oidc_signups WHERE token_hash=?", tokenHash(token));
    return viewer;
  });
}

/** What Elytra last copied from the issuer's profile for this link. */
export function syncedProfile(issuer: string, subject: string): { name: string | null; picture: string | null } | null {
  return one<{ name: string | null; picture: string | null }>("SELECT synced_name AS name,synced_picture AS picture FROM identity_links WHERE issuer=? AND subject=?", issuer, subject) ?? null;
}
/** Copies the issuer's changed name and picture onto the linked user. `avatarUrl` is the local
 * file made from `picture`, or null when the picture was removed. Returns replaced avatar files to delete. */
export function applyProfileSync(issuer: string, subject: string, update: { name?: string; picture?: { url: string | null; avatarUrl: string | null } }): string[] {
  return transaction(() => {
    const link = one<{ user_id: string; synced_avatar_url: string | null }>("SELECT user_id,synced_avatar_url FROM identity_links WHERE issuer=? AND subject=?", issuer, subject);
    const user = link && one<UserRow>("SELECT * FROM users WHERE id=?", link.user_id);
    if (!link || !user) return [];
    const obsolete: string[] = [];
    if (update.name !== undefined) {
      const displayName = [...update.name.trim()].slice(0, 50).join("");
      try {
        if (displayName) { assertNameAllowed(displayName, "display_name", user.id); run("UPDATE users SET display_name=? WHERE id=?", displayName, user.id); }
      } catch (error) { if (!(error instanceof AppError && error.code === "moderated_name")) throw error; }
      // Recorded even when moderation rejects it, so the same name isn't retried on every sign-in.
      run("UPDATE identity_links SET synced_name=? WHERE issuer=? AND subject=?", update.name, issuer, subject);
    }
    if (update.picture) {
      const { url, avatarUrl } = update.picture;
      // A removed issuer photo only clears the avatar Elytra made from it, not one the person chose here.
      const replace = avatarUrl !== null || user.avatar_url === link.synced_avatar_url;
      if (replace && user.avatar_url !== avatarUrl) {
        run("UPDATE users SET avatar_url=? WHERE id=?", avatarUrl, user.id);
        if (user.avatar_url) obsolete.push(user.avatar_url);
      }
      run("UPDATE identity_links SET synced_picture=?,synced_avatar_url=? WHERE issuer=? AND subject=?", url, avatarUrl, issuer, subject);
    }
    return obsolete;
  });
}

/** Stores the sealed refresh token for pushing profile edits, or clears it with null. */
export function saveRefreshToken(issuer: string, subject: string, sealed: string | null): void {
  run("UPDATE identity_links SET refresh_token=? WHERE issuer=? AND subject=?", sealed, issuer, subject);
}
/** The linked user's current name and avatar next to what was last synced with the issuer. */
export function profilePushState(userId: string, issuer: string) {
  return one<{ subject: string; refresh_token: string | null; synced_name: string | null; synced_avatar_url: string | null; display_name: string; avatar_url: string | null }>(
    `SELECT l.subject,l.refresh_token,l.synced_name,l.synced_avatar_url,u.display_name,u.avatar_url
      FROM identity_links l JOIN users u ON u.id=l.user_id WHERE l.user_id=? AND l.issuer=?`, userId, issuer) ?? null;
}
/** Records what the issuer now has after a push, so the next sign-in doesn't copy it back. */
export function recordPushedProfile(issuer: string, subject: string, pushed: { name?: string; picture?: { url: string | null; avatarUrl: string | null } }): void {
  if (pushed.name !== undefined) run("UPDATE identity_links SET synced_name=? WHERE issuer=? AND subject=?", pushed.name, issuer, subject);
  if (pushed.picture) run("UPDATE identity_links SET synced_picture=?,synced_avatar_url=? WHERE issuer=? AND subject=?", pushed.picture.url, pushed.picture.avatarUrl, issuer, subject);
}

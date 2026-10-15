import "server-only";
import { randomBytes } from "node:crypto";
import type { AgentToken } from "@/lib/types";
import { all, run, one } from "./core";
import { transaction } from "../db";
import { newId, tokenHash } from "../security";

export const MAX_AGENT_TOKENS = 10;
type Row = { id: string; name: string; token_hash: string; created_at: number; expires_at: number | null; last_used_at: number | null };
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
function present(row: Row, currentHash: string | null): AgentToken {
  return { id: row.id, name: row.name, createdAt: iso(row.created_at)!, expiresAt: iso(row.expires_at), lastUsedAt: iso(row.last_used_at), current: currentHash === row.token_hash };
}
/** Returns the secret once. Only its SHA-256 hash is stored, so a lost token can't be shown again. */
export function createAgentToken(userId: string, name: string, expiresInDays: number | null): AgentToken & { token: string } {
  const clean = name.trim();
  if (!clean || [...clean].length > 40) throw new Error("Token name must be 1–40 characters");
  if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) throw new Error("Expiry must be 1 to 3650 days");
  const token = `eat_${randomBytes(32).toString("hex")}`, now = Date.now();
  return transaction(() => {
    run("DELETE FROM agent_tokens WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<=?", userId, now);
    if (one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tokens WHERE user_id=?", userId)!.n >= MAX_AGENT_TOKENS) throw new Error(`You can have at most ${MAX_AGENT_TOKENS} agent tokens. Revoke one first`);
    const row: Row = { id: newId(), name: clean, token_hash: tokenHash(token), created_at: now, expires_at: expiresInDays === null ? null : now + expiresInDays * 86400000, last_used_at: null };
    run("INSERT INTO agent_tokens(id,user_id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)", row.id, userId, row.name, row.token_hash, row.created_at, row.expires_at);
    return { ...present(row, null), token };
  });
}
/** Lists unexpired tokens without secrets. `current` marks the token that made the request, so an agent can rotate itself. */
export function listAgentTokens(userId: string, currentToken: string | null): AgentToken[] {
  const hash = currentToken ? tokenHash(currentToken) : null;
  return all<Row>("SELECT * FROM agent_tokens WHERE user_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC,id DESC", userId, Date.now()).map(row => present(row, hash));
}
export function revokeAgentToken(userId: string, id: string): void {
  if (!run("DELETE FROM agent_tokens WHERE id=? AND user_id=?", id, userId).changes) throw new Error("Token not found");
}
/** Expiry of the token itself, or null if it never expires or isn't an agent token. */
export function agentTokenExpiry(token: string): string | null {
  return iso(one<{ expires_at: number | null }>("SELECT expires_at FROM agent_tokens WHERE token_hash=?", tokenHash(token))?.expires_at ?? null);
}

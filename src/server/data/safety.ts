import "server-only";
import { all, one, run } from "./core";
import { transaction } from "../db";
import { AppError } from "../errors";

/** Blocking is symmetric for visibility and interactions; muting is viewer-only. */
export function blockedIds(viewerId: string | null): Set<string> {
  return new Set(viewerId ? all<{ id: string }>(`SELECT target_id AS id FROM blocks WHERE user_id=?
    UNION SELECT user_id AS id FROM blocks WHERE target_id=?`, viewerId, viewerId).map(r => r.id) : []);
}
export function mutedIds(viewerId: string | null): Set<string> {
  return new Set(viewerId ? all<{ target_id: string }>("SELECT target_id FROM mutes WHERE user_id=?", viewerId).map(r => r.target_id) : []);
}
export function relationship(viewerId: string | null, targetId: string) {
  return {
    isBlocked: !!one("SELECT 1 FROM blocks WHERE user_id=? AND target_id=?", viewerId, targetId),
    blockedBy: !!one("SELECT 1 FROM blocks WHERE user_id=? AND target_id=?", targetId, viewerId),
    isMuted: !!one("SELECT 1 FROM mutes WHERE user_id=? AND target_id=?", viewerId, targetId),
  };
}
export function assertCanInteract(viewerId: string, targetId: string): void {
  if (one(`SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)`, viewerId, targetId, targetId, viewerId)) {
    throw new AppError(403, "blocked", "This interaction is unavailable because an account is blocked");
  }
}
export function setSafety(viewerId: string, targetId: string, kind: "block" | "mute", active: boolean): boolean {
  if (viewerId === targetId) throw new AppError(400, "invalid_target", "You cannot block or mute yourself");
  return transaction(() => {
    if (!one("SELECT id FROM users WHERE id=?", targetId)) throw new AppError(404, "not_found", "User not found");
    const table = kind === "block" ? "blocks" : "mutes";
    if (active) run(`INSERT OR IGNORE INTO ${table} VALUES(?,?,?)`, viewerId, targetId, Date.now());
    else run(`DELETE FROM ${table} WHERE user_id=? AND target_id=?`, viewerId, targetId);
    if (kind === "block" && active) {
      run("DELETE FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)", viewerId, targetId, targetId, viewerId);
      run("DELETE FROM notifications WHERE (user_id=? AND actor_id=?) OR (user_id=? AND actor_id=?)", viewerId, targetId, targetId, viewerId);
    }
    return active;
  });
}

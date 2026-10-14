import "server-only";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const newId = () => `${Date.now().toString().padStart(13, "0")}_${randomBytes(10).toString("hex")}`;
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, "hex"));
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

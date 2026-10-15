import "server-only";
import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { sharedCapacity, type Capacity } from "./concurrency";
import { backendConfig } from "./config";

export const newId = () => `${Date.now().toString().padStart(13, "0")}_${randomBytes(10).toString("hex")}`;
let passwords: Capacity | undefined;
export function passwordCapacity(): Capacity {
  const config = backendConfig();
  return passwords ??= sharedCapacity("passwords", config.passwordConcurrency, config.passwordQueue, config.passwordWaitMs);
}
function derive(password: string, salt: string): Promise<Buffer> {
  return passwordCapacity().run(() => new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  }));
}
/** Only demo initialization/seeding uses the synchronous variant. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hash, "hex"));
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

import "server-only";
import { AppError } from "../errors";

export type PageOptions = { limit: number; cursor: string | null };
export function encodeCursor(scope: string, key: (string | number)[]): string {
  return Buffer.from(JSON.stringify([scope, key])).toString("base64url");
}
export function decodeCursor(cursor: string | null, scope: string, types: ("string" | "number")[]): (string | number)[] | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== scope || !Array.isArray(value[1]) || value[1].length !== types.length) throw new Error();
    if (value[1].some((v: unknown, i: number) => typeof v !== types[i] || (typeof v === "number" && (!Number.isSafeInteger(v) || v < 0)) || (typeof v === "string" && v.length > 100))) throw new Error();
    return value[1];
  } catch { throw new AppError(400, "invalid_cursor", "Invalid cursor for this resource or account"); }
}

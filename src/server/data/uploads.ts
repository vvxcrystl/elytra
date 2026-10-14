import "server-only";
import { one, run } from "./core";
import { AppError } from "../errors";
import { newId } from "../security";
import { validateImage, saveImage, removeImages } from "../media";

export type Upload = { id: string; url: string; type: string; size: number; purpose: "post" | "avatar" | "banner"; claimed: boolean; createdAt: string };
type UploadRow = { id: string; user_id: string; url: string; type: string; size: number; purpose: Upload["purpose"]; claimed: number; created_at: number };
export function uploadById(viewerId: string, id: string): Upload {
  const row = one<UploadRow>("SELECT * FROM media_uploads WHERE id=? AND user_id=?", id, viewerId);
  if (!row) throw new AppError(404, "not_found", "Media not found");
  return { id: row.id, url: row.url, type: row.type, size: row.size, purpose: row.purpose, claimed: !!row.claimed, createdAt: new Date(row.created_at).toISOString() };
}
export async function createUpload(viewerId: string, file: File, purpose: Upload["purpose"]): Promise<Upload> {
  let image;
  try { image = await validateImage(file); }
  catch (error) { throw new AppError(400, "invalid_image", error instanceof Error ? error.message : "Invalid image"); }
  const url = await saveImage(image), id = newId();
  try { run("INSERT INTO media_uploads(id,user_id,url,type,size,purpose,created_at) VALUES(?,?,?,?,?,?,?)", id, viewerId, url, file.type, file.size, purpose, Date.now()); }
  catch (error) { await removeImages([url]); throw error; }
  return uploadById(viewerId, id);
}
/** Must be called inside the same transaction that attaches the media. */
export function claimUpload(viewerId: string, id: string, purpose: Upload["purpose"]): string {
  const upload = uploadById(viewerId, id);
  if (upload.claimed || upload.purpose !== purpose) throw new AppError(409, "media_unavailable", "Media is already attached or was uploaded for another purpose");
  run("UPDATE media_uploads SET claimed=1 WHERE id=? AND user_id=?", id, viewerId);
  return upload.url;
}

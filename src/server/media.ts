import "server-only";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

// Uploads are runtime data, not build assets to bundle into deployment traces.
export const uploadDirectory = () => process.env.ELYTRA_UPLOAD_DIR
  ? resolve(/*turbopackIgnore: true*/ process.env.ELYTRA_UPLOAD_DIR)
  : resolve(process.cwd(), "data/uploads");
export const validMediaName = (name: string) => /^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(name);
export const mediaTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export type ValidImage = { bytes: Buffer; ext: string };
export async function validateImage(file: File): Promise<ValidImage> {
  if (file.size === 0 || file.size > 5 * 1024 * 1024) throw new Error("Images must be between 1 byte and 5 MB");
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) throw new Error("Use PNG, JPEG, GIF, or WebP images");
  const bytes = Buffer.from(await file.arrayBuffer());
  let ext: string | null = null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii", 12, 16) === "IHDR") ext = "png";
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ext = "jpg";
  else if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) ext = "gif";
  else if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) ext = "webp";
  if (!ext || file.type !== mediaTypes[ext]) throw new Error("Image contents do not match a supported image type");
  return { bytes, ext };
}
export async function saveImage(image: ValidImage): Promise<string> {
  await mkdir(uploadDirectory(), { recursive: true });
  const filename = `${randomBytes(24).toString("hex")}.${image.ext}`;
  await writeFile(join(/*turbopackIgnore: true*/ uploadDirectory(), filename), image.bytes, { flag: "wx" });
  return `/api/media/${filename}`;
}
export async function removeImages(urls: string[]): Promise<void> {
  await Promise.all(urls.map(async url => {
    const filename = url.replace(/^\/api\/media\//, "");
    if (!url.startsWith("/api/media/") || !validMediaName(filename)) return;
    try { await unlink(join(/*turbopackIgnore: true*/ uploadDirectory(), filename)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Unable to remove uploaded image", error); }
  }));
}

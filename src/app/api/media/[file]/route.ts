import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadDirectory, validMediaName, mediaTypes } from "@/server/media";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await context.params;
  if (!validMediaName(file)) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(join(/*turbopackIgnore: true*/ uploadDirectory(), file));
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": mediaTypes[file.split(".").pop()!],
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch { return new Response("Not found", { status: 404 }); }
}

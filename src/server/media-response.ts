import "server-only";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { uploadDirectory, validMediaName, mediaTypes } from "./media";
import { sharedCapacity, type Capacity } from "./concurrency";
import { backendConfig } from "./config";
import { AppError } from "./errors";

let capacity: Capacity | undefined;
export async function serveMedia(request: Request, file: string): Promise<Response> {
  if (!validMediaName(file)) return new Response("Not found", { status: 404 });
  let release: (() => void) | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    release = await (capacity ??= sharedCapacity("media", backendConfig().mediaConcurrency)).acquire();
    handle = await open(join(/*turbopackIgnore: true*/ uploadDirectory(), file), "r");
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); handle = undefined; return new Response("Not found", { status: 404 }); }
    const etag = `"${file}-${info.size}"`;
    const headers = new Headers({
      "Content-Type": mediaTypes[file.split(".").pop()!], "ETag": etag,
      "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
    });
    if (request.headers.get("if-none-match")?.split(",").some(v => v.trim() === "*" || v.trim().replace(/^W\//, "") === etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Length", String(info.size));
    if (request.method === "HEAD") return new Response(null, { headers });
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, signal: request.signal });
    stream.once("close", release);
    // The stream owns the descriptor and capacity until consumed, cancelled, or errored.
    handle = undefined;
    release = undefined;
    return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array<ArrayBuffer>>, { headers });
  } catch (error) {
    if (error instanceof AppError) return new Response(error.message, { status: error.status, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response("Not found", { status: 404 });
    console.error("Unable to serve media", error);
    return new Response("Unable to serve image", { status: 500 });
  } finally {
    try { await handle?.close(); } finally { release?.(); }
  }
}

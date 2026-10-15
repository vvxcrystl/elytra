import { serveMedia } from "@/server/media-response";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  return serveMedia(request, (await context.params).file);
}
export { GET as HEAD };

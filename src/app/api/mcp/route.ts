import { handleMcp } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleMcp;
/** The server never opens a stream, so a GET has nothing to return. */
export function GET() {
  return new Response("This endpoint accepts POST only", { status: 405, headers: { Allow: "POST" } });
}

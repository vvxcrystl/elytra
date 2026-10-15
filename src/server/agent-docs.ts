import "server-only";
import { publicOrigin } from "./embed";

/**
 * Accepts only a bare http(s) origin. Without ELYTRA_PUBLIC_ORIGIN the value comes from request
 * headers a client can set, and it ends up inside text that agents read as instructions.
 */
function cleanOrigin(value: string): string | null {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(value)) return null;
  try { return new URL(value).origin === value ? value : null; } catch { return null; }
}

/** Serves one of the agent guides. The origin only fills the "use this if nothing else is set" fallback. */
export async function agentDocResponse(build: (origin: string | null) => string): Promise<Response> {
  const pinned = !!process.env.ELYTRA_PUBLIC_ORIGIN;
  return new Response(build(cleanOrigin(await publicOrigin())), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // A shared cache must not store a copy built from client-supplied headers.
      "Cache-Control": pinned ? "public, max-age=300" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { revalidatePath } from "next/cache";
import { handleApi } from "@/server/api/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  const response = await handleApi(request);
  if (response.ok && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !new URL(request.url).pathname.endsWith("/impressions")) revalidatePath("/", "layout");
  return response;
}
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as HEAD, handler as OPTIONS };

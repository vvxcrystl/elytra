import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Viewer } from "@/lib/types";
import { viewerForToken } from "./data/core";

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get("elytra_session")?.value;
  return token ? viewerForToken(token) : null;
});
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

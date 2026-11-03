import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Viewer } from "@/lib/types";
import { createSession, deleteSession, viewerForToken, SESSION_AGE } from "./data/core";

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get("elytra_session")?.value;
  return token ? viewerForToken(token) : null;
});
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}
/** Signs the browser in as `userId`, replacing any session it already had. Call from a Server Action or Route Handler. */
export async function setSession(userId: string): Promise<void> {
  const jar = await cookies();
  const previous = jar.get("elytra_session")?.value;
  const session = createSession(userId);
  if (previous) deleteSession(previous);
  jar.set("elytra_session", session.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_AGE, expires: session.expires });
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { accountsConfig } from "@/server/config";
import { getViewer, setSession } from "@/server/auth";
import { completeOidc, SIGNUP_COOKIE, STATE_COOKIE } from "@/server/oidc";

// The issuer redirects here after sign-in. Register `${ELYTRA_PUBLIC_ORIGIN}/api/oidc/callback` with it.
export async function GET(request: NextRequest) {
  const config = accountsConfig().oidc;
  if (!config) return new Response("Not found", { status: 404 });
  const jar = await cookies();
  const state = jar.get(STATE_COOKIE)?.value;
  jar.delete({ name: STATE_COOKIE, path: "/api/oidc" });
  const outcome = await completeOidc(config, request.nextUrl.searchParams, state, (await getViewer())?.id ?? null);
  switch (outcome.kind) {
    case "session":
      await setSession(outcome.userId);
      redirect("/home");
    case "linked":
      redirect("/settings?oidc=connected");
    case "signup":
      jar.set(SIGNUP_COOKIE, outcome.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/signup", maxAge: 1800 });
      redirect("/signup/finish");
    case "error":
      redirect(`${outcome.linking ? "/settings" : "/login"}?oidc=${outcome.code}`);
  }
}

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accountsConfig } from "@/server/config";
import { pendingSignup } from "@/server/data/identities";
import { SIGNUP_COOKIE } from "@/server/oidc";
import { AuthForm } from "../../auth-form";

export const metadata: Metadata = { title: "Pick your username" };

export default async function FinishSignupPage() {
  const { passwordLogin, oidc } = accountsConfig();
  if (!oidc) redirect("/login");
  const identity = pendingSignup((await cookies()).get(SIGNUP_COOKIE)?.value ?? "");
  if (!identity) redirect("/login?oidc=state");
  return (
    <AuthForm
      mode="finish"
      passwordLogin={passwordLogin}
      oidcName={oidc.name}
      defaults={{ displayName: [...identity.name].slice(0, 50).join("") }}
      picture={!!identity.picture}
    />
  );
}

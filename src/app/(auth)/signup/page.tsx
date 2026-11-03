import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { accountsConfig } from "@/server/config";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  const { passwordLogin, oidc } = accountsConfig();
  // Without passwords, new accounts start from "Continue with" on the sign-in page.
  if (!passwordLogin) redirect("/login");
  return <AuthForm mode="signup" oidcName={oidc?.name ?? null} />;
}

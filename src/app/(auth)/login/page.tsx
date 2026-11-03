import type { Metadata } from "next";
import { accountsConfig } from "@/server/config";
import { oidcMessage } from "@/server/oidc";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { passwordLogin, oidc } = accountsConfig();
  const { oidc: code } = await searchParams;
  return (
    <AuthForm
      mode="login"
      showDemo={process.env.ELYTRA_SEED_DEMO !== "false"}
      passwordLogin={passwordLogin}
      oidcName={oidc?.name ?? null}
      notice={oidcMessage(typeof code === "string" ? code : undefined)}
    />
  );
}

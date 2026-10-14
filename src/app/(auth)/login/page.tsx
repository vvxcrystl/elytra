import type { Metadata } from "next";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return <AuthForm mode="login" showDemo={process.env.ELYTRA_SEED_DEMO !== "false"} />;
}

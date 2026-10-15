import Link from "next/link";
import { redirect } from "next/navigation";
import { ViewTransition } from "react";
import { Backdrop, GLASS_CARD } from "@/components/backdrop";
import { Logo } from "@/components/logo";
import { getViewer } from "@/server/auth";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  if (await getViewer()) redirect("/home");

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <Backdrop />
      {/* Resizes when the form switches between sign in and sign up. React doesn't fire
          enter/exit here when the route group changes, so the rise in from the landing page
          and the sink on the way back key off the plain `view-transition-name` instead
          (`::view-transition-new(auth-card):only-child` in globals.css). */}
      <ViewTransition
        name="auth-card"
        update={{ "to-login": "card-resize", "to-signup": "card-resize", default: "none" }}
        default="none"
      >
        <div className={`w-full max-w-[460px] ${GLASS_CARD}`} style={{ viewTransitionName: "auth-card" }}>
          <div className="flex justify-center pt-9">
            <Link
              href="/"
              aria-label="Elytra home"
              className="rounded-xl p-1 transition-opacity hover:opacity-80"
            >
              {/* Same name as the landing page logo, which shrinks into this spot. */}
              <ViewTransition name="elytra-mark" share="mark-morph" default="none">
                <Logo className="size-12" />
              </ViewTransition>
            </Link>
          </div>
          <div className="px-8 pt-5 pb-10 sm:px-12">{children}</div>
        </div>
      </ViewTransition>
    </div>
  );
}

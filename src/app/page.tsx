import Link from "next/link";
import { redirect } from "next/navigation";
import { ViewTransition } from "react";
import { Backdrop } from "@/components/backdrop";
import { getViewer } from "@/server/auth";
import { LandingMark } from "./landing-mark";

export default async function Landing() {
  if (await getViewer()) redirect("/home");

  return (
    <div className="relative isolate flex min-h-dvh flex-col lg:flex-row">
      <Backdrop ring={false} />
      <div className="relative flex items-center p-8 lg:flex-1 lg:justify-center">
        {/* Becomes the backdrop ring on the auth pages. */}
        <ViewTransition name="elytra-ring" share="ring-morph" default="none">
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 hidden size-[min(600px,52vw)] -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/20 lg:block dark:border-accent/15"
          />
        </ViewTransition>
        <LandingMark className="size-12 lg:size-[min(340px,30vw)]" />
      </div>
      {/* Slides out as the auth card comes in (`landing-copy` in globals.css). */}
      <div className="flex flex-1 flex-col justify-center p-8 lg:pr-16" style={{ viewTransitionName: "landing-copy" }}>
        <h1 className="text-[clamp(48px,7.5vw,96px)] leading-[0.92] font-extrabold tracking-[-0.045em] text-balance">
          Happening now
        </h1>
        <h2 className="mt-8 mb-8 text-[clamp(22px,2.4vw,28px)] font-bold tracking-tight lg:mt-12">
          Join today.
        </h2>
        <div className="flex w-full max-w-[320px] flex-col">
          <Link
            href="/signup"
            className="btn-primary h-12 text-[16px] shadow-lg shadow-accent/20"
          >
            Create account
          </Link>
          <p className="mt-10 mb-3 text-[15px] font-semibold text-fg-muted">Already have an account?</p>
          <Link
            href="/login"
            className="btn-outline h-12 bg-bg/40 text-[16px] text-accent-ink backdrop-blur-sm"
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

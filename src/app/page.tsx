import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { getViewer } from "@/server/auth";

export default async function Landing() {
  if (await getViewer()) redirect("/home");

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <div className="flex items-center justify-start p-8 lg:flex-1 lg:justify-center">
        <Logo className="size-12 lg:size-[min(380px,40vw)]" />
      </div>
      <div className="flex flex-1 flex-col justify-center p-8 lg:pr-16">
        <h1 className="text-[clamp(40px,6vw,64px)] leading-[1.05] font-extrabold tracking-tight">
          Happening now
        </h1>
        <h2 className="mt-10 mb-8 text-[clamp(23px,3vw,31px)] font-extrabold">Join today.</h2>
        <div className="flex w-full max-w-[300px] flex-col gap-3">
          <Link href="/signup" className="btn-primary h-10 text-[15px]">
            Create account
          </Link>
          <p className="mt-8 mb-2 text-[17px] font-bold">Already have an account?</p>
          <Link href="/login" className="btn-outline h-10 text-[15px] text-accent-ink">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

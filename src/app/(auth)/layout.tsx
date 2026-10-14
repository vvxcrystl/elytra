import Link from "next/link";
import { redirect } from "next/navigation";
import { Backdrop, GLASS_CARD } from "@/components/backdrop";
import { Logo } from "@/components/logo";
import { getViewer } from "@/server/auth";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  if (await getViewer()) redirect("/home");

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <Backdrop />
      <div className={`w-full max-w-[460px] ${GLASS_CARD}`}>
        <div className="flex justify-center pt-8">
          <Link
            href="/"
            aria-label="Elytra"
            className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft ring-1 ring-accent/30"
          >
            <Logo className="size-8" />
          </Link>
        </div>
        <div className="px-8 pt-6 pb-10 sm:px-12">{children}</div>
      </div>
    </div>
  );
}

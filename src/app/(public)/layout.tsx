import Link from "next/link";
import { AuthenticatedShell } from "@/components/authenticated-shell";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/toast";
import { ViewerProvider } from "@/components/viewer-context";
import { getViewer } from "@/server/auth";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (viewer) return <AuthenticatedShell>{children}</AuthenticatedShell>;

  return (
    <ViewerProvider viewer={null}>
      <ToastProvider>
        <div className="mx-auto min-h-dvh max-w-[600px] sm:border-x sm:border-border">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <Link href="/" aria-label="Elytra" className="flex items-center gap-2 font-bold">
              <Logo className="size-8" />
              Elytra
            </Link>
            <div className="flex items-center gap-3 text-sm font-bold">
              <Link href="/login" className="hover:underline">Sign in</Link>
              <Link href="/signup" className="btn-primary px-4 py-2">Sign up</Link>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </ToastProvider>
    </ViewerProvider>
  );
}

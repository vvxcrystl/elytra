"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

/** Sticky, translucent column header with an optional back button. */
export function PageHeader({
  title,
  subtitle,
  back,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur-md">
      {title && (
        <div className="flex h-[53px] items-center gap-6 px-4">
          {back && (
            <button
              type="button"
              onClick={() => (window.history.length > 1 ? router.back() : router.push("/home"))}
              aria-label="Back"
              className="-ml-2 flex size-9 items-center justify-center rounded-full transition-colors hover:bg-bg-hover"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl leading-6 font-bold">{title}</h1>
            {subtitle && <p className="truncate text-[13px] text-fg-muted">{subtitle}</p>}
          </div>
        </div>
      )}
      {children}
    </header>
  );
}

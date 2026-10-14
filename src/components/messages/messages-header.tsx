"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

/** Sticky column header like PageHeader, with a back link and a right-side action slot. */
export function MessagesHeader({
  title,
  subtitle,
  backHref,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  backHref?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="flex h-[53px] items-center gap-6 px-4">
        {backHref && (
          <Link
            href={backHref}
            aria-label="Back"
            className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-bg-hover"
          >
            <ArrowLeft className="size-5" />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl leading-6 font-bold">{title}</h1>
          {subtitle && <p className="truncate text-[13px] text-fg-muted">{subtitle}</p>}
        </div>
        {actions && <div className="-mr-2 flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-8 py-10 text-center">
      <p className="text-[15px] text-fg-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-outline h-9 px-4 text-sm">
          Retry
        </button>
      )}
    </div>
  );
}

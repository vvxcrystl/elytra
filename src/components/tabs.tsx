"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export type Tab = { label: string; href: string };

/** Link-based tabs. A tab is active when its href matches the current path and query. */
export function Tabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.size ? `?${search.toString()}` : "");

  const active =
    tabs.find((t) => t.href === current) ??
    tabs.find((t) => t.href === pathname) ??
    tabs[0];

  return (
    <nav className="flex" aria-label="Tabs">
      {tabs.map((tab) => {
        const isActive = tab === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            replace
            scroll={false}
            aria-current={isActive ? "page" : undefined}
            className="flex flex-1 justify-center px-4 text-[15px] transition-colors hover:bg-bg-hover"
          >
            <span
              className={clsx(
                "relative py-4 whitespace-nowrap",
                isActive ? "font-bold text-fg" : "font-medium text-fg-muted",
              )}
            >
              {tab.label}
              {isActive && (
                <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-accent-ink" />
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

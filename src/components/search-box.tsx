"use client";

import clsx from "clsx";
import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

export function SearchBox({
  defaultValue = "",
  hideOnExplore = false,
  className,
}: {
  defaultValue?: string;
  hideOnExplore?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState(defaultValue);
  const [synced, setSynced] = useState(defaultValue);
  if (defaultValue !== synced) {
    setSynced(defaultValue);
    setQ(defaultValue);
  }

  if (hideOnExplore && pathname.startsWith("/explore")) return null;

  return (
    <form
      role="search"
      className={clsx("group relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        if (query) router.push(`/explore?q=${encodeURIComponent(query)}`);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-fg-muted group-focus-within:text-accent-ink" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search"
        aria-label="Search"
        className="h-11 w-full rounded-full border border-transparent bg-bg-muted pr-10 pl-12 text-[15px] outline-none placeholder:text-fg-muted focus:border-accent-ink focus:bg-bg focus:ring-1 focus:ring-accent-ink [&::-webkit-search-cancel-button]:hidden"
      />
      {q && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setQ("")}
          className="absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-accent-fg"
        >
          <X className="size-3" />
        </button>
      )}
    </form>
  );
}

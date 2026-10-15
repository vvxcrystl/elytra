"use client";

import { usePathname, useSearchParams } from "next/navigation";

/** Hides right rail panels on the Explore landing page, which already lists trends and people. */
export function HideOnExploreHome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  if (pathname === "/explore" && !search.get("q")) return null;
  return children;
}

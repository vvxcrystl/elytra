"use client";

import { useSyncExternalStore } from "react";
import { fullTime, shortTime } from "@/lib/format";

// One shared 30s clock for every timestamp on the page.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Short relative timestamp that ticks forward while the page is open. */
export function RelativeTime({ iso }: { iso: string }) {
  const current = useSyncExternalStore(
    subscribe,
    () => now,
    () => null,
  );

  return (
    <time dateTime={iso} title={fullTime(iso)} suppressHydrationWarning>
      {shortTime(iso, current ?? undefined)}
    </time>
  );
}

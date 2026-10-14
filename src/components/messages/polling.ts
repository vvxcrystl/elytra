"use client";

import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { getUnreadMessageCount } from "./api";

/**
 * Calls `fn` every `ms` while the tab is visible, and right away when the tab
 * becomes visible again. Skips ticks while a previous call is still running.
 */
export function usePolling(fn: () => Promise<unknown> | void, ms: number, enabled = true) {
  const tick = useEffectEvent(fn);

  useEffect(() => {
    if (!enabled) return;
    let running = false;
    const run = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await tick();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(run, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}

// Unread message count for the nav badge. One shared poller for every subscriber.
const UNREAD_POLL_MS = 30_000;
let unread = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** Re-fetches the badge count. Call after reading a conversation. */
export async function refreshUnreadMessages() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  try {
    const next = await getUnreadMessageCount();
    if (next !== unread) {
      unread = next;
      listeners.forEach((l) => l());
    }
  } catch {
    // Keep the last known count; the next tick will retry.
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    void refreshUnreadMessages();
    timer = setInterval(refreshUnreadMessages, UNREAD_POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useUnreadMessageCount() {
  return useSyncExternalStore(
    subscribe,
    () => unread,
    () => 0,
  );
}

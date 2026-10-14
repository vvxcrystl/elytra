"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { usePolling } from "./messages/polling";

const UnreadNotifications = createContext(0);

/** Keep both nav badges and the open notification list current while visible. */
export function NotificationProvider({
  initial,
  children,
}: {
  initial: { unread: number };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [snapshot, setSnapshot] = useState({ initial, unread: initial.unread });

  // Server mutations (including marking notifications read) send a fresh snapshot.
  if (snapshot.initial !== initial) {
    setSnapshot({ initial, unread: initial.unread });
  }

  usePolling(async () => {
    if (pending) return;

    // Refresh the list even if the count is unchanged (e.g. a like was undone).
    if (pathname === "/notifications") {
      startTransition(() => router.refresh());
      return;
    }

    try {
      const response = await fetch("/api/v1/notifications/unread-count", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = await response.json();
      const count: unknown = body.data?.unreadCount;
      if (typeof count === "number" && count !== snapshot.unread && document.visibilityState === "visible") {
        setSnapshot({ initial, unread: count });
      }
    } catch {
      // Keep the current badge on connection errors and retry next tick.
    }
  }, 10_000);

  return <UnreadNotifications value={snapshot.unread}>{children}</UnreadNotifications>;
}

export function useUnreadNotificationCount() {
  return useContext(UnreadNotifications);
}

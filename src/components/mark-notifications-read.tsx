"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { markNotificationsRead } from "@/server/actions";

/** Marks notifications read a moment after the page is seen, then refreshes the badge. */
export function MarkNotificationsRead() {
  const router = useRouter();
  useEffect(() => {
    let disposed = false;
    let id: ReturnType<typeof setTimeout>;
    const markRead = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      try {
        await markNotificationsRead();
        if (!disposed) router.refresh();
      } catch {
        if (!disposed) id = setTimeout(markRead, 10_000);
      }
    };
    const schedule = () => {
      clearTimeout(id);
      if (document.visibilityState === "visible") id = setTimeout(markRead, 1500);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true;
      clearTimeout(id);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [router]);
  return null;
}

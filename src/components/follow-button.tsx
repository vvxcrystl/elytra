"use client";

import clsx from "clsx";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toggleFollow } from "@/server/actions";
import { useToast } from "./toast";
import { useOptionalViewer } from "./viewer-context";

export function FollowButton({
  userId,
  following,
  size = "sm",
}: {
  userId: string;
  following: boolean;
  size?: "sm" | "md";
}) {
  const toast = useToast();
  const viewer = useOptionalViewer();
  const [state, setState] = useState(following);
  const [synced, setSynced] = useState(following);
  const [pending, startTransition] = useTransition();

  if (following !== synced) {
    setSynced(following);
    setState(following);
  }

  function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const prev = state;
    setState(!prev);
    startTransition(async () => {
      const res = await toggleFollow(userId);
      if (!res.ok) {
        setState(prev);
        toast(res.error);
      } else {
        setState(res.data.following);
      }
    });
  }

  const sizing = size === "md" ? "h-9 px-4 text-[15px]" : "h-8 px-4 text-sm";

  if (!viewer) {
    return (
      <Link href="/login" className={clsx("btn-inverse", sizing)}>
        Follow
      </Link>
    );
  }

  if (state) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={clsx(
          "group btn-outline min-w-[104px] hover:border-danger/50 hover:bg-danger/10 hover:text-danger",
          sizing,
        )}
      >
        <span className="group-hover:hidden">Following</span>
        <span className="hidden group-hover:inline">Unfollow</span>
      </button>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={pending} className={clsx("btn-inverse", sizing)}>
      Follow
    </button>
  );
}

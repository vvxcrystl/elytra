"use client";

import { Bookmark, Heart, MessageCircle, Repeat2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { compactNumber } from "@/lib/format";
import type { Post } from "@/lib/types";
import { Avatar } from "./avatar";
import { fetchPostAnalytics, type PostAnalytics } from "./post-api";
import { Spinner } from "./spinner";

const MEANINGS = {
  Impressions: "How many times other people saw this post.",
  Engagements: "Replies, reposts, likes, bookmarks, detail expands, and profile visits added together.",
  "Detail expands": "How many people opened this post.",
  "Profile visits": "How many people went to your profile from this post.",
} as const;

export function PostAnalyticsDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [analytics, setAnalytics] = useState<PostAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => {
    let current = true;
    fetchPostAnalytics(post.id).then((res) => {
      if (!current) return;
      if (res.ok) setAnalytics(res.data);
      else setError(res.error);
    });
    return () => { current = false; };
  }, [post.id]);

  const reactions = analytics && [
    { label: "Replies", value: analytics.replies, icon: MessageCircle },
    { label: "Reposts", value: analytics.reposts, icon: Repeat2 },
    { label: "Likes", value: analytics.likes, icon: Heart },
    { label: "Bookmarks", value: analytics.bookmarks, icon: Bookmark },
  ];
  const totals = analytics && ([
    ["Impressions", analytics.impressions],
    ["Engagements", analytics.engagements],
    ["Detail expands", analytics.detailExpands],
    ["Profile visits", analytics.profileVisits],
  ] as const);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[600px] overflow-y-auto rounded-2xl border border-border bg-bg text-fg shadow-xl"
    >
      <header className="flex h-[60px] items-center gap-3 px-4">
        <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Close" className="flex size-9 items-center justify-center rounded-full hover:bg-bg-hover">
          <X className="size-5" />
        </button>
        <h2 id={`${id}-title`} className="text-xl font-bold">Post analytics</h2>
      </header>

      <div className="px-5 pb-6 sm:px-8">
        <div className="flex gap-3 rounded-2xl border border-border p-4">
          <Avatar user={post.author} size="sm" />
          <div className="min-w-0 flex-1 text-[15px] leading-5">
            <p className="truncate">
              <span className="font-bold">{post.author.displayName}</span>{" "}
              <span className="text-fg-muted">@{post.author.username}</span>
            </p>
            <p className="mt-1 line-clamp-3 break-words whitespace-pre-wrap">{post.content || "Image post"}</p>
          </div>
        </div>

        {error && <p role="alert" className="mt-6 text-center text-sm text-danger">{error}</p>}
        {!analytics && !error && <div className="flex justify-center py-10"><Spinner /></div>}

        {analytics && reactions && totals && (
          <>
            <dl className="mt-4 grid grid-cols-4 rounded-2xl border border-border py-4">
              {reactions.map(({ label, value, icon: Icon }) => (
                <div key={label} className="flex flex-col items-center gap-1">
                  <Icon className="size-5 text-fg-muted [stroke-width:1.75]" aria-hidden />
                  <dt className="sr-only">{label}</dt>
                  <dd className="text-[15px] font-bold tabular-nums">{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6">
              {totals.map(([label, value]) => (
                <div key={label} title={MEANINGS[label]}>
                  <dt className="text-[15px] text-fg-muted">{label}</dt>
                  <dd className="text-4xl font-bold tabular-nums" title={value.toLocaleString()}>{compactNumber(value)}</dd>
                  <p className="mt-1 text-[13px] leading-4 text-fg-subtle">{MEANINGS[label]}</p>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </dialog>
  );
}

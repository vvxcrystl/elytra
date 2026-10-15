"use client";

import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import type { FeedItem, Page, TimelineSource } from "@/lib/types";
import { fetchTimeline, recordImpressions } from "@/server/actions";
import { PostCard } from "./post-card";
import { Spinner } from "./spinner";
import { useOptionalViewer } from "./viewer-context";

/**
 * Server renders the first page; later pages load as the sentinel scrolls into view.
 * When the server re-renders (after a mutation) the first page is replaced and extra pages reset.
 */
export function Timeline({
  source,
  initial,
  empty,
}: {
  source: TimelineSource;
  initial: Page<FeedItem>;
  empty: React.ReactNode;
}) {
  const [extra, setExtra] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [synced, setSynced] = useState(initial);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const sentinel = useRef<HTMLDivElement>(null);

  if (initial !== synced) {
    setSynced(initial);
    setExtra([]);
    setCursor(initial.nextCursor);
  }

  const loadMore = () => {
    if (!cursor || pending) return;
    setError(false);
    startTransition(async () => {
      try {
        const page = await fetchTimeline(source, cursor);
        setExtra((items) => [...items, ...page.items]);
        setCursor(page.nextCursor);
      } catch {
        setError(true);
      }
    });
  };

  const onVisible = useEffectEvent(loadMore);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) onVisible();
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor]);

  const items = dedupe([...initial.items, ...extra]);
  const listRef = useImpressions(items.length, useOptionalViewer() !== null);

  if (items.length === 0) return <>{empty}</>;

  return (
    <div ref={listRef}>
      {items.map((item) => (
        <PostCard key={item.key} post={item.post} repostedBy={item.repostedBy} />
      ))}
      {cursor && (
        <div ref={sentinel} className="flex h-20 items-center justify-center">
          {error ? (
            <button type="button" onClick={loadMore} className="btn-outline h-9 px-4 text-sm">
              Retry
            </button>
          ) : (
            <Spinner />
          )}
        </div>
      )}
    </div>
  );
}

// A post can arrive once as an original and again per repost. Keep only the newest
// appearance, which is the first one since timelines are newest-first.
function dedupe(items: FeedItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.post.id)) return false;
    seen.add(item.post.id);
    return true;
  });
}

/**
 * Reports posts that were at least half on screen, so For You can skip what you've already seen.
 * Each post is sent once per page view, batched every couple of seconds.
 */
function useImpressions(itemCount: number, signedIn: boolean) {
  const listRef = useRef<HTMLDivElement>(null);
  const sent = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const flush = () => {
      if (pending.current.size === 0) return;
      const ids = [...pending.current].slice(0, 100);
      ids.forEach((id) => pending.current.delete(id));
      if (signedIn) void recordImpressions(ids);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.postId;
          if (!entry.isIntersecting || !id || sent.current.has(id)) continue;
          sent.current.add(id);
          pending.current.add(id);
        }
      },
      { threshold: 0.5 },
    );
    observerRef.current = observer;
    const timer = setInterval(flush, 2000);
    return () => {
      flush();
      clearInterval(timer);
      observer.disconnect();
    };
  }, [signedIn]);

  // Observe newly rendered posts after each page load.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll<HTMLElement>("article[data-post-id]")
      .forEach((el) => observerRef.current?.observe(el));
  }, [itemCount]);

  return listRef;
}

"use client";

import clsx from "clsx";
import { BellOff, Ban, MailPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DisplayConversation, DisplayMessage } from "@/lib/api-types";
import { Avatar } from "../avatar";
import { EmptyState } from "../empty-state";
import { RelativeTime } from "../relative-time";
import { Spinner } from "../spinner";
import { useViewer } from "../viewer-context";
import { errorMessage, listConversations } from "./api";
import { ErrorState, MessagesHeader } from "./messages-header";
import { usePolling } from "./polling";

const INBOX_POLL_MS = 15_000;

export function Inbox() {
  const [conversations, setConversations] = useState<DisplayConversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loaded = useRef(false);

  function onFirstPage(page: Awaited<ReturnType<typeof listConversations>>) {
    setError(null);
    // Merge so conversations loaded from later pages survive a refresh of the first page.
    setConversations((prev) => mergeConversations(page.data, prev ?? []));
    if (!loaded.current) setCursor(page.nextCursor);
    loaded.current = true;
  }

  function onFirstPageError(err: unknown) {
    // Only show a full error before anything has loaded; later poll failures are silent.
    if (!loaded.current) setError(errorMessage(err));
  }

  function loadFirst() {
    return listConversations().then(onFirstPage, onFirstPageError);
  }

  const onMountPage = useEffectEvent(onFirstPage);
  const onMountError = useEffectEvent(onFirstPageError);
  useEffect(() => {
    listConversations().then(
      (page) => onMountPage(page),
      (err) => onMountError(err),
    );
  }, []);

  const hasLoaded = conversations !== null;
  usePolling(loadFirst, INBOX_POLL_MS, hasLoaded);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await listConversations(cursor);
      setConversations((items) => mergeConversations(items ?? [], page.data));
      setCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const onVisible = useEffectEvent(() => {
    if (!moreError) void loadMore();
  });
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) onVisible();
    }, { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor, hasLoaded]);

  return (
    <>
      <MessagesHeader
        title="Messages"
        actions={
          <Link
            href="/messages/new"
            aria-label="New message"
            title="New message"
            className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-bg-hover"
          >
            <MailPlus className="size-5" />
          </Link>
        }
      />

      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setError(null);
            void loadFirst();
          }}
        />
      ) : conversations === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : conversations.length === 0 ? (
        <EmptyState
          title="Welcome to your inbox!"
          body="Drop a line, share posts and more with private conversations between you and others on Elytra."
          action={
            <Link href="/messages/new" className="btn-primary h-[52px] px-8 text-[17px]">
              Write a message
            </Link>
          }
        />
      ) : (
        <ul>
          {conversations.map((c) => (
            <li key={c.id}>
              <ConversationRow conversation={c} />
            </li>
          ))}
        </ul>
      )}

      {conversations && cursor && (
        <div ref={sentinel} className="flex h-20 items-center justify-center">
          {moreError ? (
            <button type="button" onClick={loadMore} className="btn-outline h-9 px-4 text-sm">
              Retry
            </button>
          ) : (
            <Spinner />
          )}
        </div>
      )}

      <Link
        href="/messages/new"
        aria-label="New message"
        className="btn-primary fixed right-4 bottom-20 z-30 size-14 shadow-lg sm:hidden"
      >
        <MailPlus className="size-6" />
      </Link>
    </>
  );
}

/** Newest activity first, one entry per id; `fresh` wins over `rest`. */
function mergeConversations(fresh: DisplayConversation[], rest: DisplayConversation[]) {
  const byId = new Map<string, DisplayConversation>();
  for (const c of [...fresh, ...rest]) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function ConversationRow({ conversation: c }: { conversation: DisplayConversation }) {
  const viewer = useViewer();
  const unread = c.unreadCount > 0;
  const last = c.lastMessage;
  const fromViewer = last?.sender.id === viewer.id;

  return (
    <Link
      href={`/messages/${c.id}`}
      className={clsx(
        "flex gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-bg-hover",
        unread && "bg-accent-soft/40",
      )}
    >
      <Avatar user={c.participant} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[15px] leading-5">
          <span className="truncate font-bold">{c.participant.displayName}</span>
          <span className="truncate text-fg-muted">@{c.participant.username}</span>
          <span className="shrink-0 text-fg-muted">
            {" · "}
            <RelativeTime iso={last?.createdAt ?? c.updatedAt} />
          </span>
          {c.muted && <BellOff aria-label="Muted" className="ml-1 size-4 shrink-0 text-fg-muted" />}
          {c.blocked && <Ban aria-label="Blocked" className="ml-1 size-4 shrink-0 text-fg-muted" />}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p
            className={clsx(
              "min-w-0 flex-1 truncate text-[15px]",
              unread ? "font-semibold text-fg" : "text-fg-muted",
              last && !isReadable(last) && "italic",
              last?.decryptionError && "text-danger",
            )}
          >
            {last ? `${fromViewer ? "You: " : ""}${previewText(last)}` : "No messages yet"}
          </p>
          {unread && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-accent-fg">
              <span className="sr-only">Unread messages: </span>
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function isReadable(message: DisplayMessage) {
  return !message.decryptionError && !message.legacyRemoved;
}

/** Never falls back to wire data: unreadable messages get a fixed label. */
function previewText(message: DisplayMessage) {
  if (message.decryptionError) return "Message couldn't be decrypted";
  if (message.legacyRemoved) return "Unencrypted message removed";
  return message.content;
}

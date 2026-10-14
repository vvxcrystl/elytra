"use client";

import clsx from "clsx";
import {
  Ban,
  Bell,
  BellOff,
  CheckCheck,
  Lock,
  MoreHorizontal,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DisplayConversation, DisplayMessage } from "@/lib/api-types";
import { fullTime } from "@/lib/format";
import { Avatar } from "../avatar";
import { EmptyState } from "../empty-state";
import { Menu, type MenuItem } from "../menu";
import { Spinner } from "../spinner";
import { useToast } from "../toast";
import { useViewer } from "../viewer-context";
import {
  ApiError,
  deleteMessage,
  errorMessage,
  getConversation,
  getUser,
  listMessages,
  markRead,
  setBlocked,
  setMuted,
  type UserRelationship,
} from "./api";
import { conversationEncryptionInfo } from "./encryption";
import { MessageComposer } from "./message-composer";
import { ErrorState, MessagesHeader } from "./messages-header";
import { refreshUnreadMessages, usePolling } from "./polling";
import { type EncryptionInfo, VerifyDialog } from "./verify-dialog";

const THREAD_POLL_MS = 5_000;
/** Messages from the same sender closer together than this share one timestamp. */
const GROUP_GAP_MS = 5 * 60_000;

type LoadError = { status: number; message: string };
type EncryptionState =
  | { status: "loading" }
  | { status: "ok"; info: EncryptionInfo }
  // Includes changed pinned keys. Sending stays off until it's resolved.
  | { status: "error"; message: string };

export function ConversationView({ id }: { id: string }) {
  const viewer = useViewer();
  const toast = useToast();
  const router = useRouter();
  const [conversation, setConversation] = useState<DisplayConversation | null>(null);
  const [relationship, setRelationship] = useState<UserRelationship | null>(null);
  // Chronological, oldest first.
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [encryption, setEncryption] = useState<EncryptionState>({ status: "loading" });
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const lastMarked = useRef<string | null>(null);

  function fetchInitial() {
    return Promise.all([getConversation(id), listMessages(id)]);
  }

  function onInitial([conv, page]: Awaited<ReturnType<typeof fetchInitial>>) {
    setConversation(conv);
    setMessages(page.data.toReversed());
    setOlderCursor(page.nextCursor);
    getUser(conv.participant.id).then(setRelationship, () => setRelationship(null));
  }

  function onInitialError(err: unknown) {
    setLoadError({
      status: err instanceof ApiError ? err.status : 0,
      message: errorMessage(err),
    });
  }

  function retryLoad() {
    setLoadError(null);
    void fetchInitial().then(onInitial, onInitialError);
  }

  const onMountData = useEffectEvent(onInitial);
  const onMountError = useEffectEvent(onInitialError);
  useEffect(() => {
    Promise.all([getConversation(id), listMessages(id)]).then(
      (data) => onMountData(data),
      (err) => onMountError(err),
    );
  }, [id]);

  function onEncryptionInfo(info: EncryptionInfo) {
    setEncryption({ status: "ok", info });
  }

  function onEncryptionError(err: unknown) {
    setEncryption({ status: "error", message: errorMessage(err) });
  }

  function loadEncryption() {
    return conversationEncryptionInfo(id).then(onEncryptionInfo, onEncryptionError);
  }

  const onMountInfo = useEffectEvent(onEncryptionInfo);
  const onMountInfoError = useEffectEvent(onEncryptionError);
  useEffect(() => {
    conversationEncryptionInfo(id).then(
      (info) => onMountInfo(info),
      (err) => onMountInfoError(err),
    );
  }, [id]);

  async function refresh() {
    try {
      const [conv, page] = await Promise.all([getConversation(id), listMessages(id)]);
      setConversation(conv);
      setMessages((prev) => mergeLatest(prev, page.data));
      // Pick up the other person enabling encrypted messages while this is open.
      if (encryption.status === "ok" && !encryption.info.recipientReady) await loadEncryption();
    } catch {
      // Transient poll failures are ignored; the next tick retries.
    }
  }

  const hasLoaded = conversation !== null;
  usePolling(refresh, THREAD_POLL_MS, hasLoaded);

  // Mark as read whenever a new incoming message shows up, or on open if there's unread history.
  // Messages that failed to decrypt are skipped so they stay unread until the viewer acts.
  const newest = messages.some(m => m.decryptionError) ? undefined : messages.at(-1);
  const onNewest = useEffectEvent((message: DisplayMessage) => {
    if (lastMarked.current === message.id) return;
    const incoming = message.sender.id !== viewer.id;
    if (!incoming && !(lastMarked.current === null && (conversation?.unreadCount ?? 0) > 0)) {
      lastMarked.current = message.id;
      return;
    }
    if (document.visibilityState !== "visible") return;
    lastMarked.current = message.id;
    markRead(id, message.id).then(
      ({ unreadCount }) => {
        setConversation((c) => (c ? { ...c, unreadCount } : c));
        void refreshUnreadMessages();
      },
      () => {
        lastMarked.current = null;
      },
    );
  });
  useEffect(() => {
    if (newest) onNewest(newest);
  }, [newest]);

  async function markAllRead() {
    try {
      const { unreadCount } = await markRead(id);
      setConversation((c) => (c ? { ...c, unreadCount } : c));
      void refreshUnreadMessages();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await listMessages(id, olderCursor);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...page.data.filter((m) => !seen.has(m.id)).toReversed(), ...prev];
      });
      setOlderCursor(page.nextCursor);
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  const onSentinel = useEffectEvent(() => {
    if (!olderError) void loadOlder();
  });
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) onSentinel();
      },
      { root: scroller.current, rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [olderCursor, hasLoaded]);

  function onSent(message: DisplayMessage) {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    setConversation((c) => (c ? { ...c, lastMessage: message, updatedAt: message.createdAt } : c));
    // The column-reverse scroller pins to the bottom at scrollTop 0.
    scroller.current?.scrollTo({ top: 0 });
  }

  function onSendFailed(err: unknown) {
    // A 403 usually means a block happened since the page loaded.
    if (err instanceof ApiError && err.status === 403) void refresh();
    // Anything else may be a key problem (e.g. changed keys); recheck so it shows in the header.
    else if (!(err instanceof ApiError)) void loadEncryption();
  }

  async function onDelete(message: DisplayMessage) {
    if (!confirm("Delete this message for everyone? This can't be undone.")) return;
    try {
      await deleteMessage(message.id);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function toggleMute() {
    if (!relationship || !conversation) return;
    const next = !relationship.isMuted;
    try {
      const res = await setMuted(conversation.participant.id, next);
      setRelationship((r) => (r ? { ...r, isMuted: res.muted } : r));
      setConversation((c) => (c ? { ...c, muted: res.muted } : c));
      toast(res.muted ? `You muted @${conversation.participant.username}` : `You unmuted @${conversation.participant.username}`);
      void refreshUnreadMessages();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function toggleBlock() {
    if (!relationship || !conversation) return;
    const { username } = conversation.participant;
    const next = !relationship.isBlocked;
    if (next && !confirm(`Block @${username}? They won't be able to message you, and you won't be able to message them.`)) {
      return;
    }
    try {
      const res = await setBlocked(conversation.participant.id, next);
      setRelationship((r) => (r ? { ...r, isBlocked: res.blocked } : r));
      toast(res.blocked ? `You blocked @${username}` : `You unblocked @${username}`);
      await refresh();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  if (loadError) {
    return (
      <>
        <MessagesHeader title="Messages" backHref="/messages" />
        {loadError.status === 404 ? (
          <EmptyState
            title="Conversation not found"
            body="It may have been removed, or the link is wrong."
            action={
              <Link href="/messages" className="btn-primary h-11 px-6 text-[15px]">
                Back to Messages
              </Link>
            }
          />
        ) : (
          <ErrorState message={loadError.message} onRetry={retryLoad} />
        )}
      </>
    );
  }

  if (!conversation) {
    return (
      <>
        <MessagesHeader title="Messages" backHref="/messages" />
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      </>
    );
  }

  const participant = conversation.participant;
  const profileHref = `/${participant.username}`;
  const menuItems: MenuItem[] = [
    {
      label: `View @${participant.username}`,
      icon: <User className="size-[18px]" />,
      onSelect: () => router.push(profileHref),
    },
  ];
  if (encryption.status === "ok") {
    menuItems.push({
      label: "Verify encryption",
      icon: <ShieldCheck className="size-[18px]" />,
      onSelect: () => setVerifyOpen(true),
    });
  }
  if (conversation.unreadCount > 0) {
    menuItems.push({
      label: "Mark as read",
      icon: <CheckCheck className="size-[18px]" />,
      onSelect: () => void markAllRead(),
    });
  }
  if (relationship) {
    menuItems.push(
      {
        label: relationship.isMuted ? `Unmute @${participant.username}` : `Mute @${participant.username}`,
        icon: relationship.isMuted ? <Bell className="size-[18px]" /> : <BellOff className="size-[18px]" />,
        onSelect: () => void toggleMute(),
      },
      {
        label: relationship.isBlocked ? `Unblock @${participant.username}` : `Block @${participant.username}`,
        icon: <Ban className="size-[18px]" />,
        danger: !relationship.isBlocked,
        onSelect: () => void toggleBlock(),
      },
    );
  }

  return (
    // Fill the viewport so only the message list scrolls. -mb-16 cancels the main column's
    // padding for the mobile tab bar, which is hidden on this screen.
    <div className="-mb-16 flex h-dvh flex-col sm:mb-0">
      <MessagesHeader
        backHref="/messages"
        title={
          <Link href={profileHref} className="flex items-center gap-2 hover:underline">
            <Avatar user={participant} size="sm" />
            <span className="truncate">{participant.displayName}</span>
          </Link>
        }
        subtitle={
          <EncryptionStatus
            state={encryption}
            onOpen={() => setVerifyOpen(true)}
            onRetry={() => {
              setEncryption({ status: "loading" });
              void loadEncryption();
            }}
          />
        }
        actions={
          <Menu
            label="Conversation options"
            items={menuItems}
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-label="Conversation options"
                className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-bg-hover"
              >
                <MoreHorizontal className="size-5" />
              </button>
            )}
          />
        }
      />

      {/* column-reverse keeps the view pinned to the newest message as content loads above. */}
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain">
        <div className="px-4 pb-4">
          {olderCursor ? (
            <div ref={sentinel} className="flex h-16 items-center justify-center">
              {olderError ? (
                <button type="button" onClick={loadOlder} className="btn-outline h-9 px-4 text-sm">
                  Retry
                </button>
              ) : (
                <Spinner />
              )}
            </div>
          ) : (
            <ParticipantIntro user={participant} href={profileHref} />
          )}
          <MessageList messages={messages} viewerId={viewer.id} onDelete={onDelete} />
        </div>
      </div>

      {conversation.blocked ? (
        <BlockedNotice
          username={participant.username}
          youBlocked={relationship?.isBlocked ?? false}
          onUnblock={relationship?.isBlocked ? toggleBlock : undefined}
        />
      ) : encryption.status === "error" ? (
        <ComposerNotice tone="danger">
          Sending is off because the encryption keys for this conversation couldn&apos;t be
          confirmed. {encryption.message}
        </ComposerNotice>
      ) : encryption.status === "loading" ? (
        <ComposerNotice>
          <Spinner className="mx-auto size-5" />
        </ComposerNotice>
      ) : !encryption.info.recipientReady ? (
        <ComposerNotice>
          @{participant.username} hasn&apos;t set up encrypted messages yet. Once they open
          Messages on Elytra and turn it on, you can send them a message here.
        </ComposerNotice>
      ) : (
        <MessageComposer conversationId={id} onSent={onSent} onError={onSendFailed} />
      )}

      {encryption.status === "ok" && (
        <VerifyDialog
          open={verifyOpen}
          onClose={() => setVerifyOpen(false)}
          conversationId={id}
          username={participant.username}
          info={encryption.info}
          onVerified={() => void loadEncryption()}
        />
      )}
    </div>
  );
}

function EncryptionStatus({
  state,
  onOpen,
  onRetry,
}: {
  state: EncryptionState;
  onOpen: () => void;
  onRetry: () => void;
}) {
  if (state.status === "loading") return <span>Checking encryption…</span>;
  if (state.status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex max-w-full items-center gap-1 font-semibold text-danger hover:underline"
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="truncate">Safety check failed. Retry</span>
      </button>
    );
  }
  const { verified, recipientReady } = state.info;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx(
        "inline-flex max-w-full items-center gap-1 hover:underline",
        verified && "text-accent-ink",
      )}
    >
      {verified ? <ShieldCheck className="size-3.5 shrink-0" /> : <Lock className="size-3.5 shrink-0" />}
      <span className="truncate">
        {!recipientReady
          ? "Waiting for them to set up encryption"
          : verified
            ? "End-to-end encrypted · Verified"
            : "End-to-end encrypted · Not verified"}
      </span>
    </button>
  );
}

function ComposerNotice({
  tone,
  children,
}: {
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={clsx(
        "shrink-0 border-t border-border px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center text-[15px]",
        tone === "danger" ? "text-danger" : "text-fg-muted",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Applies a fresh newest-first page to the chronological list. Inside the page's time window
 * the server is authoritative, so messages deleted by the other side disappear. Messages
 * outside the window (older history, or ones sent after the poll started) are kept.
 */
function mergeLatest(prev: DisplayMessage[], page: DisplayMessage[]): DisplayMessage[] {
  if (page.length === 0) return [];
  const newestAt = page[0].createdAt;
  const oldestAt = page[page.length - 1].createdAt;
  const fetched = new Set(page.map((m) => m.id));
  const kept = prev.filter(
    (m) => !fetched.has(m.id) && (m.createdAt < oldestAt || m.createdAt > newestAt),
  );
  return [...kept, ...page].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function ParticipantIntro({ user, href }: { user: DisplayConversation["participant"]; href: string }) {
  return (
    <Link
      href={href}
      className="-mx-4 mb-4 flex flex-col items-center border-b border-border px-4 py-6 text-center transition-colors hover:bg-bg-hover"
    >
      <Avatar user={user} size="lg" />
      <p className="mt-2 text-[15px] font-bold">{user.displayName}</p>
      <p className="text-[15px] text-fg-muted">@{user.username}</p>
    </Link>
  );
}

function MessageList({
  messages,
  viewerId,
  onDelete,
}: {
  messages: DisplayMessage[];
  viewerId: string;
  onDelete: (message: DisplayMessage) => void;
}) {
  if (messages.length === 0) {
    return <p className="py-6 text-center text-[15px] text-fg-muted">No messages yet. Say hello!</p>;
  }

  return (
    <ol className="flex flex-col gap-1">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const next = messages[i + 1];
        const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
        const endsGroup =
          !next ||
          next.sender.id !== m.sender.id ||
          Date.parse(next.createdAt) - Date.parse(m.createdAt) > GROUP_GAP_MS;
        return (
          <li key={m.id} className="flex flex-col">
            {newDay && <DayDivider iso={m.createdAt} />}
            <MessageBubble
              message={m}
              mine={m.sender.id === viewerId}
              showTime={endsGroup}
              onDelete={onDelete}
            />
          </li>
        );
      })}
    </ol>
  );
}

function MessageBubble({
  message,
  mine,
  showTime,
  onDelete,
}: {
  message: DisplayMessage;
  mine: boolean;
  showTime: boolean;
  onDelete: (message: DisplayMessage) => void;
}) {
  return (
    <div className={clsx("group flex flex-col", mine ? "items-end" : "items-start", showTime && "mb-3")}>
      <div className={clsx("flex max-w-[85%] items-center gap-1 sm:max-w-[75%]", mine && "flex-row-reverse")}>
        {message.decryptionError ? (
          <p
            className={clsx(
              "flex min-w-0 items-start gap-2 rounded-3xl border border-danger/40 bg-danger/5 px-4 py-2.5 text-[15px] leading-5 text-danger",
              mine ? "rounded-br-md" : "rounded-bl-md",
            )}
          >
            <ShieldAlert className="mt-px size-4 shrink-0" />
            <span>
              This message couldn&apos;t be decrypted. It may have been changed in transit or
              encrypted for different keys.
            </span>
          </p>
        ) : message.legacyRemoved ? (
          <p
            className={clsx(
              "min-w-0 rounded-3xl border border-dashed border-border px-4 py-2.5 text-[15px] leading-5 text-fg-muted italic",
              mine ? "rounded-br-md" : "rounded-bl-md",
            )}
          >
            This message was sent before end-to-end encryption, and its text has been removed.
          </p>
        ) : (
          <p
            className={clsx(
              "min-w-0 rounded-3xl px-4 py-2.5 text-[15px] leading-5 break-words whitespace-pre-wrap",
              mine ? "rounded-br-md bg-accent text-accent-fg" : "rounded-bl-md bg-bg-muted text-fg",
            )}
          >
            {message.content}
          </p>
        )}
        {mine && (
          <button
            type="button"
            onClick={() => onDelete(message)}
            aria-label="Delete message"
            title="Delete message"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-[opacity,color,background-color] hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      {showTime && (
        <time dateTime={message.createdAt} className="mt-1 px-1 text-[13px] text-fg-muted">
          {fullTime(message.createdAt)}
        </time>
      )}
    </div>
  );
}

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function DayDivider({ iso }: { iso: string }) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const label =
    dayKey(iso) === dayKey(today.toISOString())
      ? "Today"
      : dayKey(iso) === dayKey(yesterday.toISOString())
        ? "Yesterday"
        : date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
          });
  return (
    <p className="my-3 text-center text-[13px] font-medium text-fg-muted">
      {label}
    </p>
  );
}

function BlockedNotice({
  username,
  youBlocked,
  onUnblock,
}: {
  username: string;
  youBlocked: boolean;
  onUnblock?: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-border px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center">
      <p className="text-[15px] text-fg-muted">
        {youBlocked
          ? `You blocked @${username}. Unblock them to send messages.`
          : "You can no longer send messages to this person."}
      </p>
      {onUnblock && (
        <button type="button" onClick={onUnblock} className="btn-outline mt-3 h-9 px-4 text-sm">
          Unblock @{username}
        </button>
      )}
    </div>
  );
}

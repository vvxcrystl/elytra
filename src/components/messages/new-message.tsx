"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { UserListItem } from "@/lib/types";
import { Avatar } from "../avatar";
import { Spinner } from "../spinner";
import { useToast } from "../toast";
import { errorMessage, openConversationId, searchUsers } from "./api";
import { ErrorState, MessagesHeader } from "./messages-header";

const SEARCH_DEBOUNCE_MS = 250;

type Results =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; users: UserListItem[] };

export function NewMessage() {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const query = q.trim();

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setResults({ status: "loading" });
      searchUsers(query, controller.signal).then(
        (users) => setResults({ status: "done", users: users.filter((u) => !u.isSelf) }),
        (err) => {
          if (!controller.signal.aborted) setResults({ status: "error", message: errorMessage(err) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, attempt]);

  async function open(user: UserListItem) {
    if (opening) return;
    setOpening(user.id);
    try {
      const conversationId = await openConversationId(user.id);
      router.push(`/messages/${conversationId}`);
    } catch (err) {
      toast(errorMessage(err));
      setOpening(null);
    }
  }

  return (
    <>
      <MessagesHeader title="New message" backHref="/messages">
        <div className="relative mx-4 mb-2">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-fg-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value.trim()) setResults({ status: "idle" });
            }}
            autoFocus
            placeholder="Search people"
            aria-label="Search people"
            className="h-11 w-full rounded-full border border-transparent bg-bg-muted pr-4 pl-12 text-[15px] outline-none placeholder:text-fg-muted focus:border-accent-ink focus:bg-bg focus:ring-1 focus:ring-accent-ink"
          />
        </div>
      </MessagesHeader>

      {!query || results.status === "idle" ? (
        <p className="px-8 py-10 text-center text-[15px] text-fg-muted">
          Search by name or username to start a conversation.
        </p>
      ) : results.status === "loading" ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : results.status === "error" ? (
        <ErrorState message={results.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : results.users.length === 0 ? (
        <p className="px-8 py-10 text-center text-[15px] text-fg-muted">
          No people found for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul>
          {results.users.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => open(user)}
                disabled={opening !== null}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-hover disabled:cursor-wait"
              >
                <Avatar user={user} />
                <span className="min-w-0 flex-1 leading-5">
                  <span className="block truncate font-bold">{user.displayName}</span>
                  <span className="block truncate text-[15px] text-fg-muted">@{user.username}</span>
                </span>
                {opening === user.id && <Spinner className="size-5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

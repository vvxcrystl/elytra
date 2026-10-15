"use client";

import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Post } from "@/lib/types";
import { Avatar } from "./avatar";
import { PostContent } from "./post-content";
import { Composer } from "./composer";
import { RelativeTime } from "./relative-time";

type ComposeOptions = { replyTo?: Post; quote?: Post };
type OpenCompose = (options?: ComposeOptions) => void;

const ComposeContext = createContext<OpenCompose>(() => {});

export function useCompose() {
  return useContext(ComposeContext);
}

export function ComposeProvider({ children }: { children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Bumping the key remounts the composer so each open starts empty.
  const [state, setState] = useState<{ key: number; options: ComposeOptions } | null>(null);

  const open = useCallback<OpenCompose>((options = {}) => {
    setState((s) => ({ key: (s?.key ?? 0) + 1, options }));
  }, []);

  const close = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    if (state && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [state]);

  const { replyTo, quote } = state?.options ?? {};

  return (
    <ComposeContext value={open}>
      {children}
      <dialog
        ref={dialogRef}
        onClose={() => setState(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        aria-label={replyTo ? "Reply" : "New post"}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-bg text-fg backdrop:bg-overlay sm:mx-auto sm:mt-[5vh] sm:bottom-auto sm:h-auto sm:max-h-[90vh] sm:max-w-[600px] sm:rounded-2xl"
      >
        {state && (
          <div className="flex flex-col">
            <div className="sticky top-0 z-10 flex h-[53px] items-center bg-bg/85 px-2 backdrop-blur">
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="flex size-9 items-center justify-center rounded-full hover:bg-bg-hover"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="px-4 pb-2">
              {replyTo && (
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <Avatar user={replyTo.author} />
                    <div className="my-1 w-0.5 flex-1 bg-border" />
                  </div>
                  <div className="min-w-0 flex-1 pb-3">
                    <div className="flex items-center gap-1 text-[15px]">
                      <span className="truncate font-bold">{replyTo.author.displayName}</span>
                      <span className="truncate text-fg-muted">@{replyTo.author.username}</span>
                      <span className="text-fg-muted">·</span>
                      <span className="text-fg-muted">
                        <RelativeTime iso={replyTo.createdAt} />
                      </span>
                    </div>
                    <PostContent text={replyTo.content} className="text-[15px]" />
                    <p className="mt-3 text-[15px] text-fg-muted">
                      Replying to <span className="text-link">@{replyTo.author.username}</span>
                    </p>
                  </div>
                </div>
              )}
              <Composer
                key={state.key}
                replyTo={replyTo}
                quote={quote}
                placeholder={quote ? "Add a comment" : undefined}
                autoFocus
                onPosted={close}
              />
            </div>
          </div>
        )}
      </dialog>
    </ComposeContext>
  );
}

"use client";

import clsx from "clsx";
import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DisplayMessage } from "@/lib/api-types";
import { MESSAGE_MAX_LENGTH, errorMessage, messageLength, sendMessage } from "./api";

/** Show the character counter once this close to the limit. */
const COUNTER_THRESHOLD = 500;

export function MessageComposer({
  conversationId,
  onSent,
  onError,
}: {
  conversationId: string;
  onSent: (message: DisplayMessage) => void;
  onError?: (err: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const remaining = MESSAGE_MAX_LENGTH - messageLength(text);
  const empty = text.trim().length === 0;
  const tooLong = remaining < 0;
  const canSend = !empty && !tooLong && !sending;

  async function submit() {
    if (empty) return;
    if (tooLong) {
      setError(`Messages can be up to ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const message = await sendMessage(conversationId, text.trim());
      setText("");
      onSent(message);
    } catch (err) {
      setError(errorMessage(err));
      onError?.(err);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  return (
    <form
      className="shrink-0 border-t border-border bg-bg px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error && (
        <p role="alert" className="px-2 pb-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 rounded-3xl bg-bg-muted py-1 pr-1 pl-4 focus-within:ring-1 focus-within:ring-accent-ink">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter adds a line. Leave IME composition alone.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder="Start a new message"
          aria-label="Message"
          aria-invalid={tooLong || undefined}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] leading-5 outline-none placeholder:text-fg-muted"
        />
        <div className="flex shrink-0 items-center gap-1">
          {remaining <= COUNTER_THRESHOLD && (
            <span
              aria-live="polite"
              className={clsx("px-1 text-[13px] tabular-nums", tooLong ? "text-danger" : "text-fg-muted")}
            >
              {remaining}
            </span>
          )}
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            title="Send"
            className="flex size-9 items-center justify-center rounded-full text-accent-ink transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <SendHorizontal className="size-5" />
          </button>
        </div>
      </div>
    </form>
  );
}

"use client";

import clsx from "clsx";
import { ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPost } from "@/server/actions";
import {
  POST_MAX_IMAGES,
  POST_MAX_LENGTH,
  type Post,
  type QuotedPost,
} from "@/lib/types";
import { Avatar } from "./avatar";
import { QuoteCard } from "./quote-card";
import { HASHTAG } from "./rich-text";
import { useToast } from "./toast";
import { useViewer } from "./viewer-context";

type Attachment = { file: File; url: string };

export function Composer({
  replyTo,
  quote,
  placeholder,
  autoFocus,
  compact,
  submitLabel,
  onPosted,
}: {
  replyTo?: Post;
  quote?: Post | QuotedPost;
  placeholder?: string;
  autoFocus?: boolean;
  /** Inline reply box under a post: collapsed until focused. */
  compact?: boolean;
  submitLabel?: string;
  onPosted?: (id: string) => void;
}) {
  const viewer = useViewer();
  const toast = useToast();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke preview URLs when attachments go away.
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url)),
    [],
  );

  const length = [...text].length;
  const remaining = POST_MAX_LENGTH - length;
  const hasContent = text.trim().length > 0 || attachments.length > 0 || !!quote;
  const canSubmit = hasContent && remaining >= 0 && !pending;

  function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    const room = POST_MAX_IMAGES - attachments.length;
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (picked.length > room) setError(`You can attach up to ${POST_MAX_IMAGES} images.`);
    setAttachments((prev) => [
      ...prev,
      ...picked.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      URL.revokeObjectURL(prev[index].url);
      return prev.filter((_, i) => i !== index);
    });
  }

  function submit() {
    if (!canSubmit) return;
    const form = new FormData();
    form.set("content", text.trim());
    if (replyTo) form.set("replyToId", replyTo.id);
    if (quote) form.set("quoteId", quote.id);
    attachments.forEach((a) => form.append("images", a.file));

    startTransition(async () => {
      const result = await createPost(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      attachments.forEach((a) => URL.revokeObjectURL(a.url));
      setText("");
      setAttachments([]);
      setError(null);
      if (compact) setExpanded(false);
      const href = `/${viewer.username}/status/${result.data.id}`;
      toast(replyTo ? "Your reply was sent." : "Your post was sent.", {
        href,
        label: "View",
      });
      onPosted?.(result.data.id);
    });
  }

  return (
    <div className="flex gap-3">
      <Avatar user={viewer} className="mt-1" />
      <div className="min-w-0 flex-1">
        {replyTo && expanded && compact && (
          <p className="pt-1 text-[15px] text-fg-muted">
            Replying to{" "}
            <span className="text-accent-ink">@{replyTo.author.username}</span>
          </p>
        )}
        <div className={clsx("flex gap-3", compact && !expanded && "items-center")}>
          <div className="relative min-h-[52px] min-w-0 flex-1">
            <HighlightedText text={text} />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setExpanded(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length > 0) {
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }
              }}
              autoFocus={autoFocus}
              rows={1}
              placeholder={placeholder ?? (replyTo ? "Post your reply" : "What's happening?")}
              aria-label={placeholder ?? "Post text"}
              className="absolute inset-0 block size-full resize-none overflow-hidden bg-transparent py-3 text-xl leading-7 text-transparent caret-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          {compact && !expanded && (
            <button type="button" disabled className="btn-primary h-9 px-4 text-[15px]">
              Reply
            </button>
          )}
        </div>

        {attachments.length > 0 && (
          <div
            className={clsx(
              "mb-3 grid gap-2",
              attachments.length === 1 ? "grid-cols-1" : "grid-cols-2",
            )}
          >
            {attachments.map((a, i) => (
              <div key={a.url} className="relative overflow-hidden rounded-2xl border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.url}
                  alt=""
                  className={clsx(
                    "w-full object-cover",
                    attachments.length === 1 ? "max-h-[420px]" : "aspect-square",
                  )}
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  aria-label="Remove image"
                  className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur hover:bg-black/80"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {quote && expanded && (
          <div className="mb-3">
            <QuoteCard quote={"deleted" in quote ? quote : { ...quote, deleted: false }} linked={false} />
          </div>
        )}

        {error && <p className="mb-2 text-sm text-danger">{error}</p>}

        {expanded && (
          <div className="flex items-center justify-between border-t border-border pt-2 pb-1">
            <div className="-ml-2 flex items-center">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={attachments.length >= POST_MAX_IMAGES}
                aria-label="Add images"
                title="Add images"
                className="flex size-9 items-center justify-center rounded-full text-accent-ink transition-colors hover:bg-accent-soft disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ImageIcon className="size-5" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              {length > 0 && <CharCounter remaining={remaining} />}
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="btn-primary h-9 px-4 text-[15px]"
              >
                {pending ? "Posting…" : (submitLabel ?? (replyTo ? "Reply" : "Post"))}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mirrors the textarea's text underneath it so hashtags can be colored. It sets
 * the field's height, so its font, padding and wrapping must match the textarea.
 */
function HighlightedText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      <span key={index} className="text-accent-ink">
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  parts.push(text.slice(last));

  return (
    <div
      aria-hidden
      className="pointer-events-none py-3 text-xl leading-7 break-words whitespace-pre-wrap text-fg"
    >
      {parts}
      {/* A trailing newline collapses unless something follows it. */}
      {"\u200b"}
    </div>
  );
}

function CharCounter({ remaining }: { remaining: number }) {
  const used = Math.min(1, (POST_MAX_LENGTH - remaining) / POST_MAX_LENGTH);
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const warn = remaining <= 20;
  const over = remaining < 0;

  return (
    <div className="flex items-center gap-2" aria-label={`${remaining} characters remaining`}>
      {warn && (
        <span className={clsx("text-[13px] tabular-nums", over ? "text-danger" : "text-fg-muted")}>
          {remaining}
        </span>
      )}
      <svg className="size-6 -rotate-90" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - used)}
          className={over ? "stroke-danger" : warn ? "stroke-amber-500" : "stroke-accent-ink"}
        />
      </svg>
    </div>
  );
}

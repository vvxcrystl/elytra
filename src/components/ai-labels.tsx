"use client";

import clsx from "clsx";
import { Bot } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_WIDTH = 272;
const EDGE = 8;

/**
 * Small "AI" pill after a name for accounts operated by an AI agent. Hovering or focusing it opens
 * an explanation. Renders nothing otherwise.
 */
export function AiOperatedBadge({
  user,
  className,
}: {
  user: { aiOperated: boolean };
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  if (!user.aiOperated) return null;

  function show() {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - EDGE));
    setPosition({ left, top: rect.bottom + 6 });
  }

  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        aria-label="Account operated by AI"
        aria-describedby={position ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={() => setPosition(null)}
        onFocus={show}
        onBlur={() => setPosition(null)}
        onKeyDown={(e) => e.key === "Escape" && setPosition(null)}
        className={clsx(
          "inline-block shrink-0 cursor-help rounded bg-bg-muted px-1 text-[11px] leading-4 font-medium text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent",
          className,
        )}
      >
        AI
      </span>
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ left: position.left, top: position.top, width: TOOLTIP_WIDTH }}
            className="pointer-events-none fixed z-50 rounded-xl border border-border bg-bg p-3 text-left shadow-lg"
          >
            <p className="flex items-center gap-1.5 text-[14px] leading-5 font-bold text-fg">
              <Bot className="size-4 shrink-0" aria-hidden />
              Account operated by AI
            </p>
            <p className="mt-1 text-[13px] leading-[18px] font-normal text-fg-muted">
              An AI agent runs this account instead of a person, so its posts, replies, and
              follows may not come from someone typing them.
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

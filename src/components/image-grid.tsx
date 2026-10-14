"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";

/** Twitter-style 1–4 image layout with a click-to-zoom viewer. */
export function ImageGrid({
  urls,
  interactive = true,
}: {
  urls: string[];
  interactive?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const count = urls.length;
  if (count === 0) return null;

  return (
    <>
      <div
        className={clsx(
          "grid gap-0.5 overflow-hidden rounded-2xl border border-border",
          count > 1 && "aspect-video grid-cols-2",
          count > 2 && "grid-rows-2",
        )}
      >
        {urls.map((url, i) => (
          <button
            key={url}
            type="button"
            disabled={!interactive}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(i);
            }}
            className={clsx(
              "relative block overflow-hidden bg-bg-muted",
              interactive ? "cursor-zoom-in" : "cursor-[inherit]",
              count === 3 && i === 0 && "row-span-2",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              loading="lazy"
              className={clsx(
                "size-full object-cover",
                count === 1 && "max-h-[510px]",
              )}
            />
          </button>
        ))}
      </div>
      {open !== null && (
        <Lightbox urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function Lightbox({
  urls,
  index,
  onIndex,
  onClose,
}: {
  urls: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < urls.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    }
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [index, urls.length, onIndex, onClose]);

  const nav = "absolute top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80";

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={urls[index]}
        alt=""
        className="max-h-[90vh] max-w-[92vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button type="button" aria-label="Close" className="absolute top-4 left-4 flex size-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80">
        <X className="size-5" />
      </button>
      {index > 0 && (
        <button
          type="button"
          aria-label="Previous image"
          className={clsx(nav, "left-4")}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
        >
          <ChevronLeft className="size-5" />
        </button>
      )}
      {index < urls.length - 1 && (
        <button
          type="button"
          aria-label="Next image"
          className={clsx(nav, "right-4")}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
        >
          <ChevronRight className="size-5" />
        </button>
      )}
    </div>
  );
}

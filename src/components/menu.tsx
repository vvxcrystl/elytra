"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

export type MenuItem = {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onSelect: () => void;
};

/** Small anchored popover menu. Closes on outside click and Escape. */
export function Menu({
  trigger,
  items,
  label,
  align = "right",
  side = "bottom",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  items: MenuItem[];
  label: string;
  align?: "left" | "right";
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={clsx(
            "absolute z-50 min-w-48 overflow-hidden rounded-xl border border-border bg-bg-elevated py-1 shadow-xl shadow-black/20",
            align === "right" ? "right-0" : "left-0",
            side === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={clsx(
                "flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] font-semibold transition-colors hover:bg-bg-hover",
                item.danger ? "text-danger" : "text-fg",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useState } from "react";

type Toast = { id: number; message: string; href?: string; linkLabel?: string };
type ToastFn = (message: string, link?: { href: string; label: string }) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback<ToastFn>((message, link) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, message, href: link?.href, linkLabel: link?.label }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastContext value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-4 rounded-lg bg-accent px-4 py-3 text-[15px] font-medium text-accent-fg shadow-lg"
          >
            <span>{t.message}</span>
            {t.href && (
              <Link href={t.href} className="font-bold underline-offset-2 hover:underline">
                {t.linkLabel}
              </Link>
            )}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

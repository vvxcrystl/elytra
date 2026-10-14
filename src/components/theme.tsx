"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const listeners = new Set<() => void>();

function read(): Theme {
  const t = localStorage.getItem("theme");
  return t === "light" || t === "dark" ? t : "system";
}

function apply(theme: Theme) {
  const resolved =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.dataset.theme = resolved;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (read() === "system") apply("system");
  };
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(cb);
    media.removeEventListener("change", onChange);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme);

  const setTheme = useCallback((next: Theme) => {
    if (next === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", next);
    apply(next);
    listeners.forEach((l) => l());
  }, []);

  return { theme, setTheme };
}

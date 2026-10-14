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

export function ThemePicker() {
  const { theme, setTheme } = useTheme();

  return (
    <select
      aria-label="Color theme"
      value={theme}
      onChange={(event) => setTheme(event.currentTarget.value as Theme)}
      className="btn-outline h-9 px-3 text-[15px]"
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}

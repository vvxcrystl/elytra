"use client";

import { useCallback, useSyncExternalStore } from "react";

/** "christmas" swaps the palette and follows the system light or dark preference. */
export type Theme = "light" | "dark" | "system" | "christmas";

const listeners = new Set<() => void>();

function read(): Theme {
  const t = localStorage.getItem("theme");
  return t === "light" || t === "dark" || t === "christmas" ? t : "system";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme =
    theme === "light" || theme === "dark"
      ? theme
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  if (theme === "christmas") root.dataset.palette = "christmas";
  else delete root.dataset.palette;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const current = read();
    if (current === "system" || current === "christmas") apply(current);
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
      <option value="christmas">Christmas</option>
    </select>
  );
}

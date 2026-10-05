import { useSyncExternalStore } from "react";

/**
 * The one place the theme is read, written, and watched.
 *
 * Dark is the default (`index.html` ships `class="dark"`), and the stored value
 * is the only override, so a first-time visitor gets dark rather than whatever
 * the OS says. `next-themes` was the registry's default for the toast surface;
 * it is a second theme authority in a tree that already has one, so the toast
 * reads this instead.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "factory.theme";

const listeners = new Set<() => void>();
let current: Theme | null = null;

const isTheme = (value: string | null): value is Theme =>
  value === "dark" || value === "light";

/**
 * Cached, because `useSyncExternalStore` compares snapshots by identity: a
 * fresh read on every call would re-render forever.
 */
export const readTheme = (): Theme => {
  if (current !== null) return current;
  const stored =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(STORAGE_KEY);
  current = isTheme(stored) ? stored : "dark";
  return current;
};

export const setTheme = (theme: Theme): void => {
  current = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem(STORAGE_KEY, theme);
  for (const listener of listeners) listener();
};

/**
 * Applied once before the first render.
 *
 * `index.html` ships `class="dark"`, so a stored `light` is the one case that has
 * to be written to the document explicitly. Without this the class says dark
 * while the store says light, and the toggle disagrees with the page.
 */
export const applyStoredTheme = (): void => {
  document.documentElement.classList.toggle("dark", readTheme() === "dark");
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useTheme = (): Theme =>
  useSyncExternalStore(subscribe, readTheme, () => "dark");

import { useSyncExternalStore } from "react";

/**
 * App appearance: dark, light, or follow the system. Stored per browser.
 * The choice is applied as <html data-theme="dark|light">; index.css swaps the colour variables.
 * index.html applies the same logic before React loads, so the page never flashes the wrong theme.
 */
export type ThemeChoice = "dark" | "light" | "system";

const KEY = "cutir:theme";
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

let choice: ThemeChoice = read();
const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;

function apply() {
  const light = choice === "light" || (choice === "system" && !!media?.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

media?.addEventListener?.("change", () => choice === "system" && apply());
apply();

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage blocked: the choice lasts for this session */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => choice
  );
}

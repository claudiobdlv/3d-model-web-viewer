import type { ThemeMode } from "./types";

const storageKey = "viewer-theme";

export function initialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem(storageKey, theme);
}

export function toggleTheme(theme: ThemeMode): ThemeMode {
  return theme === "dark" ? "light" : "dark";
}

"use client";

/**
 * The visitor's theme: "system" follows prefers-color-scheme in CSS; "light" or
 * "dark" is an explicit choice kept in a cookie the root layout reads, so the
 * server renders <html data-theme> and the first paint is already right.
 */
import { useSyncExternalStore } from "react";
import { THEME_COOKIE, type ThemeChoice } from "./theme-cookie";

export type { ThemeChoice };

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } else {
    root.setAttribute("data-theme", choice);
    document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; SameSite=Lax`;
  }
  window.dispatchEvent(new Event("clause-theme"));
}

function resolved(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  window.addEventListener("clause-theme", listener);
  return () => {
    media.removeEventListener("change", listener);
    window.removeEventListener("clause-theme", listener);
  };
}

/** The theme actually showing ("light" | "dark"); null during SSR and hydration. */
export function useResolvedTheme(): "light" | "dark" | null {
  return useSyncExternalStore(subscribe, resolved, () => null);
}

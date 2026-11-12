"use client";

import { useSyncExternalStore } from "react";

/**
 * True while the viewport is at least `width` wide (a CSS length such as
 * "110rem", matching a breakpoint in globals.css). False on the server and on
 * the first client render, so markup that depends on it hydrates without a
 * mismatch and switches on the next frame.
 */
export function useMinWidth(width: string): boolean {
  const query = `(min-width: ${width})`;
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

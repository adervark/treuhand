"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `fn` now and then every `ms` while the tab is visible, and again when
 * the window regains focus. Restarts when `ms` or `key` changes. The first
 * call runs from a timer callback so the effect itself never sets state.
 */
export function usePolling(fn: () => unknown, ms: number, key: unknown = null): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    const run = () => {
      if (!document.hidden) void fnRef.current();
    };
    const first = setTimeout(() => void fnRef.current(), 0);
    const interval = setInterval(run, ms);
    window.addEventListener("focus", run);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
      window.removeEventListener("focus", run);
    };
  }, [ms, key]);
}

"use client";

import { useSyncExternalStore } from "react";
import { formatLocal, formatRelative, formatTape, formatUtc } from "./format";

const noopSubscribe = () => () => {};

/** False during SSR and hydration, true afterwards: lets times switch to the viewer's zone without a mismatch. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** Absolute time in the viewer's zone (UTC before hydration). */
export function LocalTime({ iso, withTime = true, className }: { iso: string; withTime?: boolean; className?: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} className={className} title={formatUtc(iso)}>
      {hydrated ? formatLocal(iso, withTime) : formatUtc(iso, withTime)}
    </time>
  );
}

/** "Nov 11 02:44:12" for the audit tape: the viewer's zone after hydration, UTC before. */
export function TapeTime({ iso, className }: { iso: string; className?: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} className={className} title={formatUtc(iso)}>
      {formatTape(iso, hydrated ? "local" : "utc")}
    </time>
  );
}

/** "in 2 days" / "3 minutes ago", falling back to the absolute UTC date before hydration. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} className={className} title={hydrated ? formatLocal(iso) : formatUtc(iso)}>
      {hydrated ? formatRelative(iso) : formatUtc(iso, false)}
    </time>
  );
}

// A shared clock for render-time comparisons ("is this overdue?") that stays pure:
// components read a snapshot that ticks every 15 s instead of calling Date.now() while rendering.
let clockNow = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  clockNow = Date.now();
  clockTimer ??= setInterval(() => {
    clockNow = Date.now();
    clockListeners.forEach((l) => l());
  }, 15_000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** Milliseconds since the epoch, refreshed every 15 s; null during SSR and hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => null,
  );
}
